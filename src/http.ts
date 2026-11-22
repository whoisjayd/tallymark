import { describeRequest } from './hit.js'
import { isDimension, TOP_DIMENSIONS, toCsv } from './query.js'
import { TRACKER } from './script.js'
import type { Tallymark } from './tallymark.js'
import type {
  ConnInfo,
  Dimension,
  Filters,
  FunnelStep,
  Interval,
  RangeInput,
  TopDimension,
} from './types.js'

// ── Rate limiter ──────────────────────────────────────────────────────────────

/**
 * Sliding-window limiter held in memory. Best-effort by design: on serverless
 * each isolate has its own window, which is still enough to blunt a naive flood.
 * Put Cloudflare / Vercel rate limiting in front for hard guarantees.
 */
export class RateLimiter {
  private buckets = new Map<string, number[]>()

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** Returns `true` if the hit is over the limit. */
  hit(key: string, now: number): boolean {
    const hits = (this.buckets.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (hits.length >= this.max) {
      this.buckets.set(key, hits)
      return true
    }
    hits.push(now)
    this.buckets.set(key, hits)
    if (this.buckets.size > 5000) {
      for (const [k, v] of this.buckets) {
        if (!v.some((t) => now - t < this.windowMs)) this.buckets.delete(k)
      }
      // Distinct keys, including spoofed forwarded IPs, must not grow without bound.
      while (this.buckets.size > 5000) {
        const oldest = this.buckets.keys().next().value
        if (oldest === undefined) break
        this.buckets.delete(oldest)
      }
    }
    return false
  }
}

// ── Request handler ───────────────────────────────────────────────────────────

const MAX_BODY = 8 * 1024
const MAX_IMPORT = 32 * 1024 * 1024
const RANGES = new Set(['1h', '24h', '7d', '30d', '90d', '365d'])

/** Read at most `max` bytes. Returns null if the body is larger, without buffering it all. */
async function readBounded(req: Request, max: number): Promise<string | null> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    all.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(all)
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

/**
 * Routes (relative to `basePath`):
 *
 *   POST /collect          public    record a pageview / event
 *   GET  /script.js        public    the browser tracker
 *   GET  /health           public    liveness
 *   GET  /api/summary      API key   totals, bounce rate, session length
 *   GET  /api/timeseries   API key   visitors / pageviews over time
 *   GET  /api/top?by=path  API key   top pages, referrers, countries, ...
 *   GET  /api/compare      API key   this period vs. the previous one
 *   GET  /api/funnel       API key   ordered funnel (?steps=/pricing,event:Signup)
 *   GET  /api/sessions     API key   recent sessions with the pages and events in order
 *   GET  /api/journeys     API key   the most common routes through the site
 *   GET  /api/realtime     API key   visitors in the last 5 minutes
 *   GET  /api/events       API key   raw events
 *   GET  /api/export.csv   API key   CSV download
 *   GET  /api/export.ndjson API key  full-fidelity backup
 *   POST /api/import       API key   restore a backup (NDJSON body)
 */
export function createHandler(
  engine: Tallymark,
  now: () => number,
  onError: (error: unknown) => void,
) {
  const o = engine.options
  const base = (o.basePath ?? '').replace(/\/$/, '')
  const respectDnt = o.respectDnt ?? true
  const origins = o.allowedOrigins ?? '*'
  const limiter =
    o.rateLimit === false
      ? null
      : new RateLimiter(o.rateLimit?.max ?? 120, o.rateLimit?.windowMs ?? 60_000)

  const corsFor = (req: Request): Record<string, string> => {
    const origin = req.headers.get('origin')
    if (origins === '*') return { 'access-control-allow-origin': '*' }
    if (origin && origins.includes(origin)) {
      return { 'access-control-allow-origin': origin, vary: 'Origin' }
    }
    return {}
  }

  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extra,
      },
    })

  async function collect(req: Request, info: ConnInfo): Promise<Response> {
    const cors = corsFor(req)
    const origin = req.headers.get('origin')
    if (origins !== '*' && origin && !origins.includes(origin)) {
      return json({ ok: false, error: 'origin' }, 403)
    }
    if (o.strictOrigin && o.allowedHosts) {
      const src = req.headers.get('origin') ?? req.headers.get('referer')
      let host = ''
      try {
        host = src ? new URL(src).hostname.replace(/^www\./, '').toLowerCase() : ''
      } catch {
        /* unparseable = rejected below */
      }
      const allowed = o.allowedHosts.map((h) => h.toLowerCase().replace(/^www\./, ''))
      if (!allowed.includes(host)) return json({ ok: false, error: 'origin' }, 403)
    }
    // Ignored hits return 202, not an error: don't teach bots what tripped them,
    // and don't spam the visitor's console.
    const ignored = (reason: string) => json({ ok: true, ignored: reason }, 202, cors)

    if (respectDnt && (req.headers.get('dnt') === '1' || req.headers.get('sec-gpc') === '1')) {
      return ignored('dnt')
    }

    // Browsers speculatively load pages the user may never see.
    const purpose = (
      req.headers.get('sec-purpose') ??
      req.headers.get('purpose') ??
      ''
    ).toLowerCase()
    if (purpose.includes('prefetch') || purpose.includes('prerender')) return ignored('prefetch')

    const trust = o.trustProxy ?? true
    const facts = describeRequest(req, info, trust)
    // A browser always sends a user agent. Without one it is a script.
    if (!facts.userAgent) return ignored('bot')
    const ip = facts.ip
    // No IP means no honest bucket key. A shared bucket would let one client
    // throttle everyone, so limit only when we can tell clients apart.
    if (limiter && ip && limiter.hit(ip, now())) {
      return json({ ok: false, error: 'rate_limited' }, 429, { ...cors, 'retry-after': '60' })
    }

    const declared = Number(req.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413, cors)
    const text = await readBounded(req, MAX_BODY)
    if (text === null) return json({ ok: false, error: 'too_large' }, 413, cors)

    let body: Record<string, unknown>
    try {
      body = JSON.parse(text)
      if (!body || typeof body !== 'object') throw new Error()
    } catch {
      return json({ ok: false, error: 'bad_json' }, 400, cors)
    }

    const result = await engine.track(
      {
        name: typeof body.name === 'string' ? body.name : undefined,
        url: typeof body.url === 'string' ? body.url : '',
        referrer: typeof body.referrer === 'string' ? body.referrer : null,
        props: body.props as never,
        value: typeof body.value === 'number' ? body.value : undefined,
        // Short keys from the tracker: w = viewport width, d = engaged ms, s = scroll depth.
        screenWidth: typeof body.w === 'number' ? body.w : undefined,
        duration: typeof body.d === 'number' ? body.d : undefined,
        scroll: typeof body.s === 'number' ? body.s : undefined,
        ...facts,
      },
      info,
    )
    if (!result.ok) {
      if (result.reason === 'invalid') return json({ ok: false, error: 'invalid' }, 422, cors)
      if (result.reason === 'storage')
        return json({ ok: false, error: 'storage' }, 503, { ...cors, 'retry-after': '30' })
      return ignored(result.reason)
    }
    return json({ ok: true }, 202, cors)
  }

  function authorised(req: Request): boolean {
    if (!o.apiKey) return false
    const header = req.headers.get('authorization') ?? ''
    // RFC 7235: the auth scheme is case-insensitive.
    const token = /^bearer /i.test(header) ? header.slice(7) : ''
    return timingSafeEqual(token, o.apiKey)
  }

  function parseRange(p: URLSearchParams): RangeInput | { error: string } {
    const from = p.get('from')
    const to = p.get('to')
    if (from || to) {
      const f = toMs(from)
      const t = to ? toMs(to) : now() + 1
      // A bound that is given but unparseable is an error, not a default.
      if (f === null || t === null || f >= t) return { error: 'bad_range' }
      return { from: f, to: t }
    }
    const r = p.get('range') ?? '7d'
    return RANGES.has(r) ? (r as RangeInput) : { error: 'bad_range' }
  }

  function parseFilters(p: URLSearchParams): Filters {
    const f: Filters = {}
    // Any dimension, including `prop:<name>`, can be used as a filter.
    for (const [k, v] of p) {
      if (v && isDimension(k)) f[k as Dimension] = v
    }
    return f
  }

  async function api(req: Request, route: string, p: URLSearchParams): Promise<Response> {
    if (!authorised(req)) {
      return json({ ok: false, error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
    }
    const range = parseRange(p)
    if (typeof range === 'object' && 'error' in range)
      return json({ ok: false, error: range.error }, 400)
    const filters = parseFilters(p)

    switch (route) {
      case '/api/summary':
        return json({ ok: true, data: await engine.summary(range, filters) })
      case '/api/timeseries': {
        const i = p.get('interval')
        const interval: Interval | undefined =
          i === 'hour' || i === 'day' || i === 'week' || i === 'month' ? i : undefined
        return json({ ok: true, data: await engine.timeseries(range, filters, interval) })
      }
      case '/api/top': {
        const by = p.get('by') as TopDimension | null
        if (!by || !(TOP_DIMENSIONS.includes(by) || isDimension(by))) {
          return json({ ok: false, error: 'bad_dimension', allowed: TOP_DIMENSIONS }, 400)
        }
        // A dimension can't also be its own filter, or the answer is one row.
        if (by !== 'entry_page' && by !== 'exit_page') delete filters[by as Dimension]
        const limit = Number(p.get('limit') ?? 10)
        return json({
          ok: true,
          data: await engine.top(by, range, filters, Number.isFinite(limit) ? limit : 10),
        })
      }
      case '/api/compare':
        return json({ ok: true, data: await engine.compare(range, filters) })
      case '/api/funnel': {
        const steps = parseSteps(p.get('steps'))
        if (!steps)
          return json(
            { ok: false, error: 'bad_steps', hint: 'steps=/pricing,event:Signup (2-10 steps)' },
            400,
          )
        return json({ ok: true, data: await engine.funnel(steps, range, filters) })
      }
      case '/api/export.ndjson':
        return new Response(await engine.export(range, filters), {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': 'attachment; filename="tallymark.ndjson"',
            'cache-control': 'no-store',
          },
        })
      case '/api/sessions': {
        const limit = Number(p.get('limit') ?? 50)
        return json({
          ok: true,
          data: await engine.sessions(range, filters, Number.isFinite(limit) ? limit : 50),
        })
      }
      case '/api/journeys': {
        const depth = Number(p.get('depth') ?? 3)
        const limit = Number(p.get('limit') ?? 10)
        return json({
          ok: true,
          data: await engine.journeys(range, filters, {
            depth: Number.isFinite(depth) ? depth : 3,
            limit: Number.isFinite(limit) ? limit : 10,
          }),
        })
      }
      case '/api/realtime':
        return json({ ok: true, data: await engine.realtime() })
      case '/api/events': {
        const raw = Number(p.get('limit') ?? 100)
        // `-1` is truthy, so `n || fallback` would pass it through. Postgres then
        // rejects LIMIT -1 and the handler answers 500.
        const limit = Number.isFinite(raw) ? Math.min(5000, Math.max(1, Math.floor(raw))) : 100
        return json({ ok: true, data: await engine.events(range, filters, limit) })
      }
      case '/api/export.csv': {
        const csv = toCsv(await engine.events(range, filters, 100_000))
        return new Response(csv, {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="tallymark.csv"',
            'cache-control': 'no-store',
          },
        })
      }
      default:
        return json({ ok: false, error: 'not_found' }, 404)
    }
  }

  return async function handle(req: Request, info: ConnInfo = {}): Promise<Response> {
    try {
      const url = new URL(req.url)
      let route = url.pathname
      if (base && route.startsWith(base)) route = route.slice(base.length) || '/'
      route = route.replace(/\/$/, '') || '/'

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsFor(req),
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'content-type, authorization',
            'access-control-max-age': '86400',
          },
        })
      }

      if (route === '/collect') {
        return req.method === 'POST'
          ? await collect(req, info)
          : json({ ok: false }, 405, { allow: 'POST, OPTIONS' })
      }
      if (route === '/script.js' && req.method === 'GET') {
        return new Response(TRACKER, {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'public, max-age=86400',
            'access-control-allow-origin': '*',
          },
        })
      }
      if (route === '/health') return json({ ok: true })
      if (route === '/api/import') {
        if (req.method !== 'POST') return json({ ok: false }, 405, { allow: 'POST' })
        if (!authorised(req))
          return json({ ok: false, error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
        const text = await readBounded(req, MAX_IMPORT)
        if (text === null) return json({ ok: false, error: 'too_large' }, 413)
        return json({ ok: true, data: await engine.import(text) })
      }
      if (route.startsWith('/api/') && req.method === 'GET')
        return await api(req, route, url.searchParams)

      return json({ ok: false, error: 'not_found' }, 404)
    } catch (error) {
      onError(error)
      // Analytics must never take a host app down, and must never leak internals.
      return json({ ok: false, error: 'internal' }, 500)
    }
  }
}

function toMs(v: string | null): number | null {
  if (!v) return null
  const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v)
  return Number.isFinite(n) ? n : null
}

/** `steps=/pricing,/docs/*,event:Signup` -> steps. 2 to 10 steps. */
function parseSteps(v: string | null): FunnelStep[] | null {
  if (!v) return null
  const steps = v.split(',').map((s): FunnelStep | null => {
    const t = s.trim()
    if (t.startsWith('event:') && t.length > 6) return { event: t.slice(6) }
    if (t.startsWith('/')) return { path: t }
    return null
  })
  if (steps.length < 2 || steps.length > 10 || steps.some((s) => s === null)) return null
  return steps as FunnelStep[]
}
