import {
  describeRequest,
  isSpamReferrer,
  NO_USER_AGENT,
  parseReferrer,
  parseUrl,
  parseUserAgent,
  randomId,
  randomSecret,
  sanitizeProps,
  screenClass,
  visitorId,
} from './hit.js'
import { createHandler } from './http.js'
import * as q from './query.js'
import { memoryStore } from './stores.js'
import type {
  Comparison,
  ConnInfo,
  EventStore,
  Filters,
  FunnelRow,
  FunnelStep,
  Interval,
  Journey,
  Props,
  Range,
  RangeInput,
  Realtime,
  SessionTrace,
  Summary,
  TallymarkEvent,
  TallymarkOptions,
  TimePoint,
  TopDimension,
  TopRow,
  TrackInput,
  TrackResult,
} from './types.js'

const RANGE_MS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  '365d': 365 * 86_400_000,
}

export interface Tallymark {
  /** Record one hit. Returns a typed result; never throws. */
  track(input: TrackInput, info?: ConnInfo): Promise<TrackResult>
  /**
   * Record a hit from a `Request` you are already handling (a route, a server action, a webhook).
   * The visitor's IP, browser, language, location and referrer are read from the request for you.
   * Omit `name` for a pageview; pass `name` (and `props`, `value`) for a custom event.
   */
  trackRequest(
    request: Request,
    event?: { name?: string; url?: string; props?: Props; value?: number },
    info?: ConnInfo,
  ): Promise<TrackResult>
  summary(range?: RangeInput, filters?: Filters): Promise<Summary>
  /** Current period vs. the equally long period right before it. */
  compare(range?: RangeInput, filters?: Filters): Promise<Comparison>
  timeseries(range?: RangeInput, filters?: Filters, interval?: Interval): Promise<TimePoint[]>
  top(by: TopDimension, range?: RangeInput, filters?: Filters, limit?: number): Promise<TopRow[]>
  /** Ordered conversion funnel over pages and/or custom events. */
  funnel(steps: FunnelStep[], range?: RangeInput, filters?: Filters): Promise<FunnelRow[]>
  /** Recent sessions, each with the ordered pages and events the visitor went through. */
  sessions(range?: RangeInput, filters?: Filters, limit?: number): Promise<SessionTrace[]>
  /** The most common routes through the site (first `depth` pages of each session). */
  journeys(
    range?: RangeInput,
    filters?: Filters,
    options?: { depth?: number; limit?: number },
  ): Promise<Journey[]>
  realtime(windowMinutes?: number): Promise<Realtime>
  /** Raw events, newest last. */
  events(range?: RangeInput, filters?: Filters, limit?: number): Promise<TallymarkEvent[]>
  /** Backup: newline-delimited JSON, one event per line. */
  export(range?: RangeInput, filters?: Filters): Promise<string>
  /** Restore from `export()` output. Invalid lines are skipped; duplicates are ignored by id. */
  import(ndjson: string): Promise<{ imported: number; skipped: number }>
  /** Delete events past `retentionDays`. Wire to a cron. Returns rows removed. */
  prune(): Promise<number>
  /** Fetch-standard handler: `(Request) => Response`. Mount it anywhere. */
  handle(request: Request, info?: ConnInfo): Promise<Response>
  readonly store: EventStore
  readonly options: Readonly<TallymarkOptions>
}

/** Structural check for imported data: never trust a backup file blindly. */
export function isTallymarkEvent(v: unknown): v is TallymarkEvent {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  const str = (x: unknown): x is string => typeof x === 'string'
  const nstr = (x: unknown) => x === null || typeof x === 'string'
  const u = e.utm as Record<string, unknown> | undefined
  return (
    str(e.id) &&
    e.id.length > 0 &&
    e.id.length <= 64 &&
    (e.type === 'pageview' || e.type === 'event' || e.type === 'engagement') &&
    str(e.name) &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts) &&
    str(e.visitor) &&
    str(e.hostname) &&
    str(e.path) &&
    nstr(e.referrer) &&
    nstr(e.referrerHost) &&
    !!u &&
    typeof u === 'object' &&
    ['source', 'medium', 'campaign', 'term', 'content'].every((k) => nstr(u[k])) &&
    nstr(e.browser) &&
    nstr(e.os) &&
    nstr(e.country) &&
    nstr(e.region) &&
    nstr(e.city) &&
    nstr(e.language) &&
    nstr(e.browserVersion) &&
    nstr(e.osVersion) &&
    nstr(e.timezone) &&
    (e.screen === null || ['mobile', 'tablet', 'laptop', 'desktop'].includes(e.screen as string)) &&
    (e.duration === null || (typeof e.duration === 'number' && Number.isFinite(e.duration))) &&
    (e.scroll === null || (typeof e.scroll === 'number' && Number.isFinite(e.scroll))) &&
    ['desktop', 'mobile', 'tablet', 'unknown'].includes(e.device as string) &&
    !!e.props &&
    typeof e.props === 'object' &&
    !Array.isArray(e.props) &&
    (e.value === null || (typeof e.value === 'number' && Number.isFinite(e.value)))
  )
}

export function createTallymark(options: TallymarkOptions = {}): Tallymark {
  const now = options.now ?? Date.now
  const store = options.store ?? memoryStore()
  const secret = options.secret ?? randomSecret()
  const sessionMinutes = options.sessionMinutes ?? 30
  const respectDnt = options.respectDnt ?? true
  const allowedHosts = options.allowedHosts?.map((h) => h.toLowerCase().replace(/^www\./, ''))
  const excludeIps = new Set(options.excludeIps ?? [])
  const report = (error: unknown, where: 'track' | 'handle' | 'prune') => {
    try {
      options.onError?.(error, { where })
    } catch {
      /* a broken logger must never break analytics */
    }
  }

  const resolve = (r: RangeInput = '7d'): Range => {
    if (typeof r !== 'string') return r
    const to = now() + 1
    return { from: to - (RANGE_MS[r] ?? RANGE_MS['7d']!), to }
  }

  const load = async (r: RangeInput | undefined, filters: Filters = {}, limit?: number) => {
    const range = resolve(r)
    const cap =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : undefined
    // A filter has to see the whole range. Limiting first keeps the newest rows,
    // then drops the ones that do not match, and the caller gets nothing.
    const filtering = Object.values(filters).some((v) => v !== undefined && v !== '')
    const events = q.applyFilters(
      q.inheritAttribution(
        await store.list({ ...range, limit: filtering ? undefined : cap }),
        sessionMinutes * 60_000,
      ),
      filters,
    )
    return { range, events: cap !== undefined ? events.slice(-cap) : events }
  }

  const engine: Tallymark = {
    store,
    options,

    async track(input, info) {
      const parsed = parseUrl(input.url)
      if (!parsed) return { ok: false, reason: 'invalid' }
      const hostname = parsed.hostname
      if (allowedHosts && !allowedHosts.includes(hostname)) return { ok: false, reason: 'host' }

      if (input.ip && excludeIps.has(input.ip)) return { ok: false, reason: 'excluded' }

      // No user agent at all means a server-side call (a webhook, a job), not a bot.
      // Requests from a browser without one are rejected before they reach track().
      const ua = input.userAgent == null ? NO_USER_AGENT : parseUserAgent(input.userAgent)
      if (ua.bot) return { ok: false, reason: 'bot' }

      const name = (input.name ?? 'pageview').trim().slice(0, 80)
      if (name === '') return { ok: false, reason: 'invalid' }
      const type = name === 'pageview' ? 'pageview' : name === 'engagement' ? 'engagement' : 'event'
      // An engagement beacon reports time on a page; without a duration it means nothing.
      if (
        type === 'engagement' &&
        !(typeof input.duration === 'number' && Number.isFinite(input.duration))
      ) {
        return { ok: false, reason: 'invalid' }
      }

      const ref = parseReferrer(input.referrer, hostname)
      if (isSpamReferrer(ref.host, options.blockedReferrers)) return { ok: false, reason: 'spam' }

      const ts = input.ts ?? now()
      if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid' }
      const value =
        typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : null

      const event: TallymarkEvent = {
        id: randomId(),
        type,
        name,
        ts,
        visitor: await visitorId(secret, ts, hostname, input.ip ?? null, input.userAgent ?? null),
        hostname,
        path: parsed.path,
        referrer: ref.referrer,
        referrerHost: ref.host,
        utm: parsed.utm,
        browser: ua.browser,
        browserVersion: ua.browserVersion,
        os: ua.os,
        osVersion: ua.osVersion,
        device: ua.device,
        country: input.country ?? null,
        region: input.region ?? null,
        city: input.city ?? null,
        timezone: input.timezone ?? null,
        language: input.language ?? null,
        screen: screenClass(input.screenWidth),
        props: type === 'engagement' ? {} : sanitizeProps(input.props),
        value: type === 'engagement' ? null : value,
        // Capped at 4 hours: a tab left open overnight is not four hundred minutes of reading.
        duration:
          type === 'engagement'
            ? Math.min(14_400_000, Math.max(0, Math.round(input.duration!)))
            : null,
        scroll:
          type === 'engagement' && typeof input.scroll === 'number' && Number.isFinite(input.scroll)
            ? Math.min(100, Math.max(0, Math.round(input.scroll)))
            : null,
      }
      // A failing database must not crash the caller; report it as a typed result.
      try {
        await store.insert(event)
      } catch (error) {
        report(error, 'track')
        return { ok: false, reason: 'storage' }
      }
      if (options.forward) {
        const forward = options.forward
        const job = Promise.resolve()
          .then(() => forward(event))
          .catch((error) => report(error, 'track'))
        if (info?.waitUntil) info.waitUntil(job)
        else await job
      }
      return { ok: true, event }
    },

    async trackRequest(request, event = {}, info = {}) {
      if (
        respectDnt &&
        (request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1')
      ) {
        return { ok: false, reason: 'dnt' }
      }
      if (!request.headers.get('user-agent')) return { ok: false, reason: 'bot' }
      const { name, url, props, value } = event
      return engine.track(
        {
          name,
          props,
          value,
          url: url ?? request.url,
          referrer: request.headers.get('referer'),
          ...describeRequest(request, info, options.trustProxy ?? true),
        },
        info,
      )
    },

    async summary(range, filters) {
      const { range: r, events } = await load(range, filters)
      return q.summary(events, r, sessionMinutes)
    },

    async compare(range, filters) {
      const current = resolve(range)
      const previous: Range = { from: current.from - (current.to - current.from), to: current.from }
      const [a, b] = await Promise.all([load(current, filters), load(previous, filters)])
      return q.compare(
        q.summary(a.events, a.range, sessionMinutes),
        q.summary(b.events, b.range, sessionMinutes),
      )
    },

    async timeseries(range, filters, interval) {
      const { range: r, events } = await load(range, filters)
      return q.timeseries(events, r, interval)
    },

    async top(by, range, filters, limit) {
      const { events } = await load(range, filters)
      return q.top(events, by, limit, sessionMinutes)
    },

    async funnel(steps, range, filters) {
      const { events } = await load(range, filters)
      return q.funnel(events, steps)
    },

    async sessions(range, filters, limit) {
      const { events } = await load(range, filters)
      return q.sessionTraces(events, sessionMinutes, limit)
    },

    async journeys(range, filters, options = {}) {
      const { events } = await load(range, filters)
      return q.journeys(events, sessionMinutes, options.depth, options.limit)
    },

    async realtime(windowMinutes = 5) {
      const t = now()
      const events = await store.list({ from: t - windowMinutes * 60_000, to: t + 1 })
      return q.realtime(events, t, windowMinutes)
    },

    async events(range, filters, limit = 1000) {
      const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1000
      return (await load(range, filters, max)).events
    },

    async export(range, filters) {
      const { events } = await load(range, filters, 1_000_000)
      return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
    },

    async import(ndjson) {
      let imported = 0
      let skipped = 0
      for (const line of ndjson.split('\n')) {
        if (line.trim() === '') continue
        let e: unknown
        try {
          e = JSON.parse(line)
        } catch {
          skipped++
          continue
        }
        if (!isTallymarkEvent(e)) {
          skipped++
          continue
        }
        await store.insert(e)
        imported++
      }
      return { imported, skipped }
    },

    async prune() {
      const days = options.retentionDays ?? 0
      if (days <= 0 || !store.prune) return 0
      try {
        return await store.prune(now() - days * 86_400_000)
      } catch (error) {
        report(error, 'prune')
        throw error
      }
    },

    handle: undefined as unknown as Tallymark['handle'],
  }

  ;(engine as { handle: Tallymark['handle'] }).handle = createHandler(engine, now, (e) =>
    report(e, 'handle'),
  )

  return engine
}
