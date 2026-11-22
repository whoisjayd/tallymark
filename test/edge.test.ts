import { describe, expect, test } from 'bun:test'
import type { EventStore } from '../src'
import { createTallymark, memoryStore, mirrorStore } from '../src'
import { cloudflare } from '../src/cloudflare'
import { clientIp, geoFromHeaders, parseUrl, sanitizeProps } from '../src/hit'
import { RateLimiter } from '../src/http'
import { timeseries, toCsv } from '../src/query'
import { sqlStore } from '../src/stores'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const T0 = Date.UTC(2026, 0, 10, 12)
const MIN = 60_000

const post = (
  a: { handle: (r: Request, i?: any) => Promise<Response> },
  body: BodyInit,
  h: Record<string, string> = {},
  info?: any,
) =>
  a.handle(
    new Request('http://x/collect', { method: 'POST', body, headers: { 'user-agent': UA, ...h } }),
    info,
  )

describe('url edge cases', () => {
  test.each([
    ['', null],
    ['nope', null],
    ['ftp://example.com/', null],
    ['data:text/html,hi', null],
    ['//evil.com/path', '/path'], // protocol-relative is a rooted path, host discarded
    [`/${'a'.repeat(3000)}`, null],
  ])('%s', (input, path) => {
    expect(parseUrl(input)?.path ?? null).toBe(path)
  })

  test('collapses slashes, strips trailing slash, drops fragments and ports', () => {
    expect(parseUrl('https://example.com:8443//a///b/#x')!.path).toBe('/a/b')
    expect(parseUrl('https://example.com:8443/')!.hostname).toBe('example.com')
  })

  test('unicode / IDN hosts and encoded paths survive', () => {
    expect(parseUrl('https://bücher.example/straße')!.hostname).toBe('xn--bcher-kva.example')
    expect(parseUrl('https://example.com/%E2%9C%93')!.path).toBe('/%E2%9C%93')
  })

  test('utm values are trimmed and capped; empty becomes null', () => {
    const u = parseUrl(`https://e.com/?utm_source=${'x'.repeat(500)}&utm_medium=%20%20`)!
    expect(u.utm.source!.length).toBe(120)
    expect(u.utm.medium).toBeNull()
  })
})

describe('props / values', () => {
  test('sanitizeProps drops junk and caps size', () => {
    expect(sanitizeProps(null)).toEqual({})
    expect(sanitizeProps([1, 2])).toEqual({})
    expect(sanitizeProps('str')).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(sanitizeProps(many)).length).toBe(20)
    expect(sanitizeProps({ '': 1, ['k'.repeat(41)]: 1, ok: 1 })).toEqual({ ok: 1 })
    expect(sanitizeProps({ n: NaN, i: Infinity, u: undefined, f: () => 1, d: new Date() })).toEqual(
      {},
    )
    expect(sanitizeProps({ s: 'x'.repeat(999) }).s).toHaveLength(200)
  })

  test('non-finite value is stored as null, not NaN', async () => {
    const a = createTallymark()
    const r = await a.track({ name: 'x', url: '/p', userAgent: UA, value: Infinity })
    expect(r.ok && r.event.value).toBeNull()
  })

  test('event named "pageview" is a pageview; blank names are invalid', async () => {
    const a = createTallymark()
    const r = await a.track({ name: 'pageview', url: '/p', userAgent: UA })
    expect(r.ok && r.event.type).toBe('pageview')
    expect(await a.track({ name: '   ', url: '/p', userAgent: UA })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    const long = await a.track({ name: 'n'.repeat(500), url: '/p', userAgent: UA })
    expect(long.ok && long.event.name.length).toBe(80)
  })
})

describe('headers / geo / ip', () => {
  test('geo sentinels are ignored, vercel city is decoded', () => {
    expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'XX' })).country).toBeNull()
    expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'T1' })).country).toBeNull()
    expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'zz9' })).country).toBeNull()
    expect(geoFromHeaders(new Headers({ 'cf-ipcountry': 'de' })).country).toBe('DE')
    expect(geoFromHeaders(new Headers({ 'x-vercel-ip-city': 'S%C3%A3o%20Paulo' })).city).toBe(
      'São Paulo',
    )
    expect(geoFromHeaders(new Headers({ 'x-vercel-ip-city': '%E0%A4%A' })).city).toBe('%E0%A4%A') // malformed: no throw
  })

  test('client ip precedence and X-Forwarded-For first hop', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '8.8.8.8, 10.0.0.1' }))).toBe('8.8.8.8')
    expect(
      clientIp(new Headers({ 'cf-connecting-ip': '2001:db8::1', 'x-forwarded-for': '1.1.1.1' })),
    ).toBe('2001:db8::1')
    expect(clientIp(new Headers())).toBeNull()
    expect(clientIp(new Headers({ 'x-forwarded-for': `${'1'.repeat(200)}, 1.1.1.1` }))).toBeNull()
  })

  test('trustProxy:false ignores spoofable headers; ConnInfo.ip is used', async () => {
    const a = createTallymark({ trustProxy: false, apiKey: 'k', secret: 's' })
    await post(
      a,
      JSON.stringify({ url: 'https://e.com/' }),
      { 'cf-ipcountry': 'DE', 'x-forwarded-for': '6.6.6.6' },
      { ip: '4.4.4.4' },
    )
    const [e] = await a.events('24h')
    expect(e!.country).toBeNull()
    // Same socket IP => same visitor even with a spoofed XFF.
    await post(
      a,
      JSON.stringify({ url: 'https://e.com/' }),
      { 'x-forwarded-for': '7.7.7.7' },
      { ip: '4.4.4.4' },
    )
    expect(new Set((await a.events('24h')).map((x) => x.visitor)).size).toBe(1)
  })

  test('the rate limiter drops the oldest keys instead of growing without bound', () => {
    const lim = new RateLimiter(1, 60_000)
    expect(lim.hit('0', 1)).toBe(false)
    expect(lim.hit('0', 1)).toBe(true)
    for (let i = 1; i <= 5001; i++) expect(lim.hit(String(i), 1)).toBe(false)
    expect(lim.hit('0', 1)).toBe(false)
  })

  test('without an IP the rate limiter does not make everyone share a bucket', async () => {
    const a = createTallymark({ trustProxy: false, rateLimit: { max: 1, windowMs: 60_000 } })
    for (let i = 0; i < 5; i++)
      expect((await post(a, JSON.stringify({ url: 'https://e.com/' }))).status).toBe(202)
  })

  test('prefetch / prerender requests are ignored', async () => {
    const a = createTallymark()
    const res = await post(a, JSON.stringify({ url: 'https://e.com/' }), {
      'sec-purpose': 'prefetch;prerender',
    })
    expect(((await res.json()) as any).ignored).toBe('prefetch')
  })
})

describe('request body edge cases', () => {
  const a = createTallymark()
  test.each([
    ['empty body', '', 400],
    ['json null', 'null', 400],
    ['json number', '42', 400],
    ['json array', '[]', 422],
    ['missing url', '{}', 422],
    ['url wrong type', '{"url":123}', 422],
    ['truncated json', '{"url":"https://e.com/"', 400],
  ])('%s', async (_n, body, status) => {
    expect((await post(a, body)).status).toBe(status)
  })

  test('chunked body with no content-length is size-limited while streaming', async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"url":"https://e.com/","p":"${'x'.repeat(20_000)}`))
        c.enqueue(new TextEncoder().encode('"}'))
        c.close()
      },
    })
    const req = new Request('http://x/collect', {
      method: 'POST',
      body: stream,
      headers: { 'user-agent': UA },
      duplex: 'half',
    } as any)
    expect((await a.handle(req)).status).toBe(413)
  })

  test('unknown routes 404, wrong methods 405, HEAD/OPTIONS handled, trailing slash ok', async () => {
    expect((await a.handle(new Request('http://x/nope'))).status).toBe(404)
    expect((await a.handle(new Request('http://x/collect'))).status).toBe(405)
    expect((await a.handle(new Request('http://x/collect/', { method: 'OPTIONS' }))).status).toBe(
      204,
    )
    expect((await a.handle(new Request('http://x/health/'))).status).toBe(200)
  })

  test('CORS: allow-list echoes only a matching origin', async () => {
    const c = createTallymark({ allowedOrigins: ['https://ok.com'] })
    const res = await c.handle(
      new Request('http://x/collect', { method: 'OPTIONS', headers: { origin: 'https://ok.com' } }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ok.com')
    const bad = await c.handle(
      new Request('http://x/collect', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.com' },
      }),
    )
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('read API edge cases', () => {
  const make = () => createTallymark({ apiKey: 'k', now: () => T0 })
  const get = (a: ReturnType<typeof make>, p: string) =>
    a.handle(new Request(`http://x${p}`, { headers: { authorization: 'Bearer k' } }))

  test('malformed / inverted / partial ranges are 400', async () => {
    const a = make()
    for (const q of ['from=abc', 'from=2026-01-02&to=2026-01-01', 'from=5&to=5', 'range=1y']) {
      expect((await get(a, `/api/summary?${q}`)).status).toBe(400)
    }
    expect((await get(a, '/api/summary?from=2026-01-01')).status).toBe(200)
    expect((await get(a, `/api/summary?from=${T0 - 1000}&to=${T0 + 1000}`)).status).toBe(200)
  })

  test('auth header variants', async () => {
    const a = make()
    for (const h of ['', 'k', 'Bearer', 'Bearer ', 'Basic k', 'Bearer kk', 'Bearer  k']) {
      const res = await a.handle(
        new Request('http://x/api/summary', { headers: h ? { authorization: h } : {} }),
      )
      expect(res.status).toBe(401)
    }
  })

  test('bearer scheme is case-insensitive', async () => {
    const a = make()
    const res = await a.handle(
      new Request('http://x/api/summary', { headers: { authorization: 'bearer k' } }),
    )
    expect(res.status).toBe(200)
  })

  test('events filters apply before the limit, and a negative limit is clamped', async () => {
    const a = createTallymark({ apiKey: 'k', secret: 's', now: () => T0 + 10_000 })
    for (let i = 0; i < 4; i++)
      await a.track({ url: `https://e.com/old`, userAgent: UA, ts: T0 + i, country: 'US' })
    for (let i = 0; i < 4; i++)
      await a.track({ url: 'https://e.com/new', userAgent: UA, ts: T0 + 100 + i, country: 'DE' })
    const filtered = (await (
      await get(a, `/api/events?from=${T0}&to=${T0 + 1000}&country=US&limit=2`)
    ).json()) as { data: { country: string }[] }
    expect(filtered.data).toHaveLength(2)
    expect(filtered.data.every((e) => e.country === 'US')).toBe(true)
    const negative = (await (
      await get(a, `/api/events?from=${T0}&to=${T0 + 1000}&limit=-1`)
    ).json()) as { data: { path: string }[] }
    expect(negative.data).toHaveLength(1)
    expect(negative.data[0]!.path).toBe('/new')
  })

  test('limit param is clamped and garbage-tolerant', async () => {
    const a = make()
    for (const l of ['abc', '-5', '0', '999999', '1e9']) {
      expect((await get(a, `/api/top?by=path&limit=${l}`)).status).toBe(200)
      expect((await get(a, `/api/events?limit=${l}`)).status).toBe(200)
    }
  })

  test('empty data yields zeros, not NaN', async () => {
    const a = make()
    const s = (await (await get(a, '/api/summary')).json()) as any
    expect(s.data).toMatchObject({
      pageviews: 0,
      visitors: 0,
      sessions: 0,
      bounceRate: 0,
      avgSessionSeconds: 0,
      viewsPerSession: 0,
    })
    expect(((await (await get(a, '/api/realtime')).json()) as any).data.visitors).toBe(0)
  })

  test('filter on the dimension being grouped does not collapse the answer', async () => {
    const a = createTallymark({ apiKey: 'k' })
    for (const p of ['/a', '/b']) await a.track({ url: p, userAgent: UA })
    const r = (await (
      await a.handle(
        new Request('http://x/api/top?by=path&path=/a', { headers: { authorization: 'Bearer k' } }),
      )
    ).json()) as any
    expect(r.data.map((x: any) => x.key).sort()).toEqual(['/a', '/b'])
  })

  test('responses are never cached and never leak errors', async () => {
    const boom: EventStore = {
      insert: async () => {
        throw new Error('secret db password')
      },
      list: async () => {
        throw new Error('secret db password')
      },
    }
    const a = createTallymark({ store: boom, apiKey: 'k' })
    const res = await get(a as any, '/api/summary')
    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).not.toContain('secret')
  })
})

describe('resilience', () => {
  test('storage failure: track returns a typed result, HTTP returns 503', async () => {
    const boom: EventStore = {
      insert: async () => {
        throw new Error('down')
      },
      list: async () => [],
    }
    const a = createTallymark({ store: boom })
    expect(await a.track({ url: '/p', userAgent: UA })).toEqual({ ok: false, reason: 'storage' })
    const res = await post(a, JSON.stringify({ url: 'https://e.com/' }))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
  })

  test('sql store recovers after a transient schema failure', async () => {
    let fail = true
    const rows: unknown[][] = []
    const store = sqlStore({
      async run(sql, params) {
        if (fail && sql.startsWith('CREATE')) throw new Error('blip')
        if (sql.startsWith('INSERT')) rows.push(params)
        return 1
      },
      async all() {
        if (fail) throw new Error('no such table')
        return []
      },
    })
    const a = createTallymark({ store })
    expect((await a.track({ url: '/p', userAgent: UA })).ok).toBe(false)
    fail = false
    expect((await a.track({ url: '/p', userAgent: UA })).ok).toBe(true)
    expect(rows.length).toBe(1)
  })

  test('concurrent cold-start inserts run the schema once', async () => {
    let ddl = 0
    const store = sqlStore({
      async run(sql) {
        if (sql.startsWith('CREATE')) ddl++
        return 1
      },
      async all() {
        return []
      },
    })
    const a = createTallymark({ store })
    await Promise.all(Array.from({ length: 20 }, () => a.track({ url: '/p', userAgent: UA })))
    expect(ddl).toBe(2) // table + index, once
  })

  test('corrupt props JSON in the database never breaks a query', async () => {
    const store = sqlStore({
      async run() {
        return 1
      },
      async all() {
        return [
          {
            id: '1',
            ts: T0,
            type: 'event',
            name: 'x',
            visitor: 'v',
            hostname: '',
            path: '/',
            props: '{bad',
            value: null,
            device: null,
          },
        ] as any
      },
    })
    const a = createTallymark({ store, now: () => T0 + 1 })
    expect((await a.events('1h'))[0]!.props).toEqual({})
  })

  test('memory store is bounded', async () => {
    const a = createTallymark({ store: memoryStore({ maxEvents: 3 }) })
    for (let i = 0; i < 10; i++) await a.track({ url: `/p${i}`, userAgent: UA })
    expect((await a.events('24h')).length).toBe(3)
  })

  test('tracking the same instant twice yields distinct ids', async () => {
    const a = createTallymark({ now: () => T0 })
    const x = await a.track({ url: '/p', userAgent: UA })
    const y = await a.track({ url: '/p', userAgent: UA })
    expect(x.ok && y.ok && x.event.id !== y.event.id).toBe(true)
  })
})

describe('query edge cases', () => {
  test('session splits exactly at the gap boundary', async () => {
    let t = T0
    const a = createTallymark({ now: () => t, sessionMinutes: 30 })
    await a.track({ url: '/a', userAgent: UA, ip: '1.1.1.1' })
    t = T0 + 30 * MIN // exactly 30 min: same session (gap must exceed)
    await a.track({ url: '/b', userAgent: UA, ip: '1.1.1.1' })
    t = T0 + 61 * MIN + 1 // > 30 min after the last hit: new session
    await a.track({ url: '/c', userAgent: UA, ip: '1.1.1.1' })
    expect((await a.summary('24h')).sessions).toBe(2)
  })

  test('an engagement beacon with no pageview in range is not a visitor', async () => {
    const a = createTallymark({ secret: 's', now: () => T0 + 20 * MIN })
    await a.track({ url: 'https://e.com/a', userAgent: UA, ip: '1.1.1.1', ts: T0 })
    await a.track({
      name: 'engagement',
      url: 'https://e.com/a',
      userAgent: UA,
      ip: '1.1.1.1',
      ts: T0 + 10 * MIN,
      duration: 10 * MIN,
    })
    const s = await a.summary({ from: T0 + 5 * MIN, to: T0 + 20 * MIN })
    expect(s).toMatchObject({ pageviews: 0, visitors: 0, sessions: 0, events: 0 })
  })

  test('a lone custom event is not counted as a bounce', async () => {
    const a = createTallymark()
    await a.track({ name: 'Signup', url: '/p', userAgent: UA, ip: '1.1.1.1' })
    const s = await a.summary('24h')
    expect(s).toMatchObject({ pageviews: 0, events: 1, sessions: 1 })
  })

  test('timeseries is bounded for absurd ranges', () => {
    const series = timeseries([], { from: 0, to: Date.UTC(2026, 0, 1) }, 'hour')
    expect(series.length).toBeLessThanOrEqual(2001)
  })

  test('csv neutralises formula injection and quotes specials', async () => {
    const a = createTallymark()
    await a.track({
      name: '=HYPERLINK("http://evil")',
      url: '/a,b',
      userAgent: UA,
      props: { note: 'line1\nline2' },
    })
    const csv = toCsv(await a.events('24h'))
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(csv).toContain('"/a,b"')
    expect(csv).toContain('line1\\nline2') // newline inside JSON props stays escaped
  })
})

describe('adapters', () => {
  test('cloudflare builds the engine once per isolate and prunes on schedule', async () => {
    let built = 0
    const w = cloudflare<{ k: string }>((env) => {
      built++
      return { apiKey: env.k, retentionDays: 1 }
    })
    const env = { k: 'k' }
    await w.fetch(new Request('http://x/health'), env)
    await w.fetch(new Request('http://x/health'), env)
    expect(built).toBe(1)
    const waited: Promise<unknown>[] = []
    await w.scheduled({}, env, { waitUntil: (p) => void waited.push(p) })
    expect(waited.length).toBe(1)
    await Promise.all(waited)
  })
})

describe('review fixes', () => {
  const get = (a: ReturnType<typeof createTallymark>, path: string) =>
    a.handle(new Request(`http://x${path}`, { headers: { authorization: 'Bearer k' } }))

  test('track() without a user agent records a server-side event', async () => {
    const a = createTallymark({ secret: 's', now: () => T0 })
    const r = await a.track({ url: 'https://example.com/', name: 'Purchase' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.browser).toBeNull()
  })

  test('a browser hit with no user-agent header is still ignored as a bot', async () => {
    const a = createTallymark({ secret: 's', now: () => T0 })
    const res = await a.handle(
      new Request('http://x/collect', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://example.com/' }),
      }),
    )
    expect(res.status).toBe(202)
    expect(((await res.json()) as any).ignored).toBe('bot')
    const r = await a.trackRequest(new Request('https://example.com/'), { name: 'x' })
    expect(r).toEqual({ ok: false, reason: 'bot' })
  })

  test('an unparseable `to` is a 400, not "now"', async () => {
    const a = createTallymark({ apiKey: 'k', now: () => T0 })
    expect((await get(a, '/api/summary?from=1&to=garbage')).status).toBe(400)
    expect((await get(a, '/api/summary?from=1')).status).toBe(200)
  })

  test('a basePath only matches whole path segments', async () => {
    const a = createTallymark({ apiKey: 'k', basePath: '/a' })
    expect((await a.handle(new Request('http://x/a/health'))).status).toBe(200)
    expect((await a.handle(new Request('http://x/ab/health'))).status).toBe(404)
  })

  test('an unknown country code from one header falls back to the next', () => {
    const h = new Headers({ 'cf-ipcountry': 'XX', 'x-vercel-ip-country': 'DE' })
    expect(geoFromHeaders(h).country).toBe('DE')
  })

  test('an empty utm_source falls back to ref', () => {
    expect(parseUrl('https://example.com/?utm_source=&ref=news')!.utm.source).toBe('news')
  })
})

describe('review fixes, round two', () => {
  const ev = (over: Record<string, unknown> = {}) =>
    ({
      id: 'e1',
      type: 'event',
      name: 'Refund',
      ts: T0,
      visitor: 'v',
      hostname: '',
      path: '/',
      referrer: null,
      referrerHost: null,
      utm: { source: null, medium: null, campaign: null, term: null, content: null },
      browser: null,
      browserVersion: null,
      os: null,
      osVersion: null,
      device: 'unknown',
      screen: null,
      country: null,
      region: null,
      city: null,
      timezone: null,
      language: null,
      props: {},
      value: -5,
      duration: null,
      scroll: null,
      ...over,
    }) as any

  test('a negative value exports as a number, text that looks like a formula is still defused', () => {
    const lines = toCsv([ev(), ev({ id: 'e2', name: '=SUM(A1)', value: null })]).split('\n')
    expect(lines[1]).toContain(',-5,')
    expect(lines[1]).not.toContain("'-5")
    expect(lines[2]).toContain("'=SUM(A1)")
  })

  test('track() rejects a timestamp that is not a finite number', async () => {
    const a = createTallymark({ secret: 's' })
    expect(await a.track({ url: 'https://example.com/', ts: Number.NaN })).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  test('a mirror that throws synchronously or fails to prune never fails the primary', async () => {
    const seen: number[] = []
    const primary = memoryStore()
    const bad: EventStore = {
      insert: () => {
        throw new Error('sync boom')
      },
      list: async () => [],
      prune: async () => {
        throw new Error('prune boom')
      },
    }
    const m = mirrorStore(primary, bad, { onError: (_e, i) => seen.push(i) })
    await m.insert(ev())
    expect(await primary.list({ from: 0, to: T0 + 1 })).toHaveLength(1)
    await m.prune?.(T0 + 1)
    expect(seen).toEqual([0, 0])
  })
})

describe('channels', () => {
  test('webmail and news readers on a search domain are not Organic Search', async () => {
    const tm = createTallymark({ secret: 's', apiKey: 'k', now: () => T0 })
    const channelFor = async (referrer: string, i: number) => {
      await tm.track({
        url: 'https://example.com/',
        referrer,
        ip: `1.1.1.${i}`,
        userAgent: UA,
        ts: T0 - 1000,
      })
    }
    await channelFor('https://mail.google.com/', 1)
    await channelFor('https://news.google.com/', 2)
    await channelFor('https://www.google.com/search', 3)
    const rows = await tm.top('channel', '24h')
    const n = (k: string) => rows.find((r) => r.key === k)?.count
    expect(n('Email')).toBe(1)
    expect(n('Referral')).toBe(1)
    expect(n('Organic Search')).toBe(1)
  })
})
