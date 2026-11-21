import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createTallymark } from '../src'
import { parseReferrer, parseUrl, parseUserAgent } from '../src/hit'
import { bunSqliteStore } from '../src/stores'

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0)
const MIN = 60_000

function make(extra = {}) {
  let t = T0
  const clock = { set: (v: number) => (t = v), now: () => t }
  const a = createTallymark({ secret: 'test-secret', apiKey: 'k', now: clock.now, ...extra })
  return { a, clock }
}

describe('parsing', () => {
  test('user agents', () => {
    expect(parseUserAgent(CHROME)).toMatchObject({
      browser: 'Chrome',
      browserVersion: '130',
      os: 'Windows',
      osVersion: null,
      device: 'desktop',
      bot: false,
    })
    expect(parseUserAgent(IPHONE)).toMatchObject({
      browser: 'Safari',
      browserVersion: '17',
      os: 'iOS',
      osVersion: '17',
      device: 'mobile',
    })
    const pixel =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    expect(parseUserAgent(pixel)).toMatchObject({
      os: 'Android',
      osVersion: '14',
      device: 'mobile',
    })
    // macOS reports a frozen version, so none is claimed.
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.2 Safari/605.1.15',
      ),
    ).toMatchObject({ os: 'macOS', osVersion: null })
    expect(parseUserAgent('Googlebot/2.1').bot).toBe(true)
    expect(parseUserAgent('').bot).toBe(true)
  })

  test('urls keep only campaign params', () => {
    const u = parseUrl('https://www.Example.com/pricing/?token=SECRET&utm_source=hn&x=1#frag')!
    expect(u.hostname).toBe('example.com')
    expect(u.path).toBe('/pricing')
    expect(u.utm.source).toBe('hn')
    expect(JSON.stringify(u)).not.toContain('SECRET')
    expect(parseUrl('javascript:alert(1)')).toBeNull()
  })

  test('internal referrers are dropped', () => {
    expect(parseReferrer('https://example.com/a', 'example.com').host).toBeNull()
    expect(parseReferrer('https://news.ycombinator.com/item?id=1', 'example.com').host).toBe(
      'news.ycombinator.com',
    )
  })
})

describe('track', () => {
  test('records a pageview without any database', async () => {
    const { a } = make()
    const r = await a.track({ url: 'https://example.com/', ip: '1.1.1.1', userAgent: CHROME })
    expect(r.ok).toBe(true)
    expect((await a.summary('24h')).pageviews).toBe(1)
  })

  test('visitor id is stable within a day, different across days and sites, never the IP', async () => {
    const { a, clock } = make()
    const hit = async (url: string) => {
      const r = await a.track({ url, ip: '9.9.9.9', userAgent: CHROME })
      return r.ok ? r.event.visitor : ''
    }
    const d1 = await hit('https://a.com/')
    expect(await hit('https://a.com/x')).toBe(d1)
    expect(await hit('https://b.com/')).not.toBe(d1)
    clock.set(T0 + 24 * 60 * MIN)
    expect(await hit('https://a.com/')).not.toBe(d1)
    expect(d1).not.toContain('9.9.9.9')
  })

  test('bots, bad urls and disallowed hosts are rejected with a reason', async () => {
    const { a } = make({ allowedHosts: ['example.com'] })
    expect(
      await a.track({ url: 'https://example.com/', ip: '1.1.1.1', userAgent: 'curl/8' }),
    ).toEqual({ ok: false, reason: 'bot' })
    expect(await a.track({ url: 'nope', ip: '1.1.1.1', userAgent: CHROME })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(await a.track({ url: 'https://evil.com/', ip: '1.1.1.1', userAgent: CHROME })).toEqual({
      ok: false,
      reason: 'host',
    })
  })

  test('props are sanitised', async () => {
    const { a } = make()
    const r = await a.track({
      name: 'Signup',
      url: 'https://example.com/',
      userAgent: CHROME,
      props: { plan: 'pro', n: 3, nested: { x: 1 }, fn: 'ok' } as never,
      value: 49,
    })
    expect(r.ok && r.event.props).toEqual({ plan: 'pro', n: 3, fn: 'ok' })
    expect(r.ok && r.event.type).toBe('event')
  })
})

describe('queries', () => {
  test('summary, sessions, bounce rate', async () => {
    const { a, clock } = make()
    const as = async (ip: string, path: string, at: number) => {
      clock.set(at)
      await a.track({ url: `https://example.com${path}`, ip, userAgent: CHROME, country: 'US' })
    }
    // Visitor A: 3 pages over 4 minutes. Visitor B: bounce. Visitor A again 2h later: new session.
    await as('1.1.1.1', '/', T0)
    await as('1.1.1.1', '/pricing', T0 + 2 * MIN)
    await as('1.1.1.1', '/docs', T0 + 4 * MIN)
    await as('2.2.2.2', '/', T0 + 5 * MIN)
    await as('1.1.1.1', '/', T0 + 125 * MIN)
    clock.set(T0 + 130 * MIN)

    const s = await a.summary('24h')
    expect(s.pageviews).toBe(5)
    expect(s.visitors).toBe(2)
    expect(s.sessions).toBe(3)
    expect(s.bounceRate).toBeCloseTo(2 / 3, 3)
    expect(s.avgSessionSeconds).toBe(240)

    const top = await a.top('path', '24h')
    expect(top[0]).toMatchObject({ key: '/', count: 3, visitors: 2 })
    expect((await a.top('country', '24h'))[0]!.key).toBe('US')
    expect(await a.top('path', '24h', { country: 'DE' })).toEqual([])
  })

  test('timeseries fills empty buckets', async () => {
    const { a, clock } = make()
    await a.track({ url: 'https://example.com/', ip: '1.1.1.1', userAgent: CHROME })
    clock.set(T0 + 3 * 3_600_000)
    const series = await a.timeseries('24h', {}, 'hour')
    expect(series.length).toBeGreaterThanOrEqual(24)
    expect(series.reduce((n, p) => n + p.pageviews, 0)).toBe(1)
  })

  test('event totals include revenue', async () => {
    const { a } = make()
    for (const ip of ['1.1.1.1', '2.2.2.2'])
      await a.track({
        name: 'Purchase',
        url: 'https://example.com/',
        ip,
        userAgent: CHROME,
        value: 25,
      })
    expect((await a.top('event', '24h'))[0]).toMatchObject({
      key: 'Purchase',
      count: 2,
      visitors: 2,
      value: 50,
    })
  })

  test('prune honours retention', async () => {
    const { a, clock } = make({ retentionDays: 30 })
    await a.track({ url: 'https://example.com/', userAgent: CHROME })
    clock.set(T0 + 31 * 86_400_000)
    expect(await a.prune()).toBe(1)
  })
})

describe('http', () => {
  const post = (
    a: ReturnType<typeof make>['a'],
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    a.handle(
      new Request('http://x/collect', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: {
          'user-agent': CHROME,
          'cf-connecting-ip': '5.5.5.5',
          'cf-ipcountry': 'DE',
          ...headers,
        },
      }),
    )
  const get = (a: ReturnType<typeof make>['a'], path: string, key?: string) =>
    a.handle(
      new Request(`http://x${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }),
    )

  test('collect -> stats, geo from headers', async () => {
    const { a } = make()
    const res = await post(a, {
      url: 'https://example.com/hi',
      referrer: 'https://news.ycombinator.com/',
    })
    expect(res.status).toBe(202)
    const body = (await (await get(a, '/api/top?by=country', 'k')).json()) as any
    expect(body.data[0].key).toBe('DE')
    expect(((await (await get(a, '/api/top?by=referrer', 'k')).json()) as any).data[0].key).toBe(
      'news.ycombinator.com',
    )
  })

  test('text/plain body works (no CORS preflight)', async () => {
    const { a } = make()
    const res = await post(a, JSON.stringify({ url: 'https://example.com/' }), {
      'content-type': 'text/plain',
    })
    expect(res.status).toBe(202)
  })

  test('DNT / GPC / bots are silently ignored', async () => {
    const { a } = make()
    expect(
      ((await (await post(a, { url: 'https://example.com/' }, { dnt: '1' })).json()) as any)
        .ignored,
    ).toBe('dnt')
    expect(
      ((await (await post(a, { url: 'https://example.com/' }, { 'sec-gpc': '1' })).json()) as any)
        .ignored,
    ).toBe('dnt')
    expect(
      (
        (await (
          await post(a, { url: 'https://example.com/' }, { 'user-agent': 'Googlebot' })
        ).json()) as any
      ).ignored,
    ).toBe('bot')
    expect((await a.summary('24h')).pageviews).toBe(0)
  })

  test('validation and size limits', async () => {
    const { a } = make()
    expect((await post(a, 'not json')).status).toBe(400)
    expect((await post(a, { url: 'nope' })).status).toBe(422)
    expect(
      (await post(a, { url: 'https://example.com/', props: { x: 'y'.repeat(9000) } })).status,
    ).toBe(413)
  })

  test('rate limiting', async () => {
    const { a } = make({ rateLimit: { max: 2, windowMs: 60_000 } })
    const codes = []
    for (let i = 0; i < 4; i++) codes.push((await post(a, { url: 'https://example.com/' })).status)
    expect(codes).toEqual([202, 202, 429, 429])
  })

  test('read API requires the key; disabled without one', async () => {
    const { a } = make()
    expect((await get(a, '/api/summary')).status).toBe(401)
    expect((await get(a, '/api/summary', 'wrong')).status).toBe(401)
    expect((await get(a, '/api/summary', 'k')).status).toBe(200)
    const open = createTallymark()
    expect((await get(open, '/api/summary', '')).status).toBe(401)
  })

  test('origin allow-list, basePath, script and csv', async () => {
    const { a } = make({ allowedOrigins: ['https://app.example.com'], basePath: '/api/analytics' })
    const bad = await a.handle(
      new Request('http://x/api/analytics/collect', {
        method: 'POST',
        body: '{}',
        headers: { origin: 'https://evil.com', 'user-agent': CHROME },
      }),
    )
    expect(bad.status).toBe(403)
    const script = await a.handle(new Request('http://x/api/analytics/script.js'))
    expect(script.headers.get('content-type')).toContain('javascript')
    expect((await script.text()).length).toBeGreaterThan(500)
    const csv = await a.handle(
      new Request('http://x/api/analytics/api/export.csv', {
        headers: { authorization: 'Bearer k' },
      }),
    )
    expect((await csv.text()).startsWith('time,type,name')).toBe(true)
  })

  test('bad params are 400, not 500', async () => {
    const { a } = make()
    expect((await get(a, '/api/top?by=password', 'k')).status).toBe(400)
    expect((await get(a, '/api/summary?range=forever', 'k')).status).toBe(400)
  })
})

describe('sql store', () => {
  test('roundtrips events through bun:sqlite', async () => {
    const { a } = make({ store: bunSqliteStore(new Database(':memory:')) })
    await a.track({
      name: 'Signup',
      url: 'https://example.com/x?utm_source=hn',
      userAgent: CHROME,
      props: { plan: 'pro' },
      value: 9,
      country: 'FR',
    })
    const [e] = await a.events('24h')
    expect(e).toMatchObject({
      name: 'Signup',
      path: '/x',
      country: 'FR',
      props: { plan: 'pro' },
      value: 9,
      utm: { source: 'hn' },
    })
    expect((await a.summary('24h')).events).toBe(1)
  })
})
