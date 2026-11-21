import { describe, expect, test } from 'bun:test'
import type { EventStore } from '../src'
import { createTallymark, memoryStore } from '../src'
import { cloudflare } from '../src/cloudflare'
import { clientIp, geoFromHeaders, parseUrl, sanitizeProps } from '../src/hit'
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
