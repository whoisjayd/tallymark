import { describe, expect, test } from 'bun:test'
import type { EventStore, TallymarkEvent } from '../src'
import {
  createTallymark,
  isTallymarkEvent,
  memoryStore,
  mirrorStore,
  verifyWebhookSignature,
  webhookSink,
} from '../src'
import { cloudflare } from '../src/cloudflare'
import { primaryLanguage } from '../src/hit'
import { nodeHandler } from '../src/node'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
const T0 = Date.UTC(2026, 0, 10, 12)
const MIN = 60_000

function make(extra = {}) {
  let t = T0
  const clock = { set: (v: number) => (t = v) }
  const a = createTallymark({ secret: 's', apiKey: 'k', now: () => t, ...extra })
  const hit = (ip: string, url: string, at = t, more: Record<string, unknown> = {}) => {
    t = at
    return a.track({ url: `https://example.com${url}`, ip, userAgent: UA, ...more })
  }
  return { a, hit, clock }
}

describe('funnel', () => {
  test('counts visitors who completed steps in order', async () => {
    const { a, hit } = make()
    // alice: pricing -> signup page -> Signup event (completes all)
    await hit('1.1.1.1', '/pricing', T0)
    await hit('1.1.1.1', '/signup', T0 + MIN)
    await hit('1.1.1.1', '/x', T0 + 2 * MIN, { name: 'Signup' })
    // bob: pricing -> signup page, never converts
    await hit('2.2.2.2', '/pricing', T0 + MIN)
    await hit('2.2.2.2', '/signup', T0 + 2 * MIN)
    // carol: lands on signup first, then pricing: wrong order, only counts for step 1 if first step matched
    await hit('3.3.3.3', '/signup', T0 + MIN)
    await hit('3.3.3.3', '/pricing', T0 + 2 * MIN)
    // dave: only visits pricing
    await hit('4.4.4.4', '/pricing', T0 + 3 * MIN)

    const rows = await a.funnel(
      [{ path: '/pricing' }, { path: '/signup' }, { event: 'Signup' }],
      '24h',
    )
    expect(rows.map((r) => r.visitors)).toEqual([4, 2, 1])
    expect(rows[1]).toMatchObject({ rate: 0.5, dropoff: 0.5, label: '/signup' })
    expect(rows[2]).toMatchObject({ rate: 0.25, dropoff: 0.5, label: 'event:Signup' })
  })

  test('prefix wildcard and empty data', async () => {
    const { a, hit } = make()
    expect(await a.funnel([{ path: '/a' }, { path: '/b' }], '24h')).toEqual([
      { step: 1, label: '/a', visitors: 0, rate: 0, dropoff: 0 },
      { step: 2, label: '/b', visitors: 0, rate: 0, dropoff: 0 },
    ])
    await hit('1.1.1.1', '/docs/intro')
    await hit('1.1.1.1', '/docs/api', T0 + MIN)
    const rows = await a.funnel([{ path: '/docs/*' }, { path: '/docs/api' }], '24h')
    expect(rows.map((r) => r.visitors)).toEqual([1, 1])
  })

  test('HTTP: parses steps, rejects bad ones', async () => {
    const { a, hit } = make()
    await hit('1.1.1.1', '/pricing')
    const get = (q: string) =>
      a.handle(new Request(`http://x/api/funnel?${q}`, { headers: { authorization: 'Bearer k' } }))
    const ok = (await (await get('steps=/pricing,event:Signup')).json()) as any
    expect(ok.data[0]).toMatchObject({ visitors: 1 })
    for (const bad of [
      'steps=/a',
      'steps=nope,/b',
      '',
      `steps=${Array(11).fill('/a').join(',')}`,
    ]) {
      expect((await get(bad)).status).toBe(400)
    }
  })
})

describe('compare / entry & exit / new dimensions', () => {
  test('compare against the previous period; null change when previous is 0', async () => {
    const { a, hit, clock } = make()
    // previous 24h window: 1 visitor. Current: 2 visitors.
    await hit('1.1.1.1', '/', T0 - 30 * 60 * MIN)
    await hit('1.1.1.1', '/', T0 - 2 * MIN)
    await hit('2.2.2.2', '/', T0 - MIN)
    clock.set(T0)
    const c = await a.compare('24h')
    expect(c.current.pageviews).toBe(2)
    expect(c.previous.pageviews).toBe(1)
    expect(c.delta.pageviews).toEqual({ current: 2, previous: 1, change: 1 })
    const empty = await make().a.compare('24h')
    expect(empty.delta.visitors.change).toBeNull()
  })

  test('entry and exit pages come from sessions', async () => {
    const { a, hit, clock } = make()
    await hit('1.1.1.1', '/landing', T0)
    await hit('1.1.1.1', '/pricing', T0 + MIN)
    await hit('1.1.1.1', '/signup', T0 + 2 * MIN)
    await hit('2.2.2.2', '/landing', T0 + MIN)
    clock.set(T0 + 10 * MIN)
    expect((await a.top('entry_page', '24h'))[0]).toMatchObject({ key: '/landing', count: 2 })
    const exits = await a.top('exit_page', '24h')
    expect(exits.map((r) => r.key).sort()).toEqual(['/landing', '/signup'])
  })

  test('hostname supports many sites in one instance', async () => {
    const { a } = make()
    for (const h of ['a.com', 'a.com', 'b.com'])
      await a.track({ url: `https://${h}/`, ip: '1.1.1.1', userAgent: UA })
    expect((await a.top('hostname', '24h'))[0]).toMatchObject({ key: 'a.com', count: 2 })
    expect((await a.summary('24h', { hostname: 'b.com' })).pageviews).toBe(1)
  })

  test('language comes from Accept-Language and is only the primary tag', async () => {
    expect(primaryLanguage('en-US,en;q=0.9,fr;q=0.8')).toBe('en-US')
    expect(primaryLanguage('de')).toBe('de')
    expect(primaryLanguage('*')).toBeNull()
    expect(primaryLanguage('<script>')).toBeNull()
    expect(primaryLanguage(null)).toBeNull()
    const { a } = make()
    await a.handle(
      new Request('http://x/collect', {
        method: 'POST',
        body: '{"url":"https://example.com/"}',
        headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' },
      }),
    )
    expect((await a.top('language', '24h'))[0]).toMatchObject({ key: 'pt-BR' })
  })
})

describe('abuse controls', () => {
  test('excludeIps, referrer spam (incl. subdomains), custom blocklist', async () => {
    const { a } = make({ excludeIps: ['9.9.9.9'], blockedReferrers: ['evil.example'] })
    expect(await a.track({ url: 'https://example.com/', ip: '9.9.9.9', userAgent: UA })).toEqual({
      ok: false,
      reason: 'excluded',
    })
    const ref = (r: string) =>
      a.track({ url: 'https://example.com/', ip: '1.1.1.1', userAgent: UA, referrer: r })
    expect(await ref('https://semalt.com/')).toEqual({ ok: false, reason: 'spam' })
    expect(await ref('https://www.x.semalt.com/')).toEqual({ ok: false, reason: 'spam' })
    expect(await ref('https://a.evil.example/')).toEqual({ ok: false, reason: 'spam' })
    expect((await ref('https://notsemalt.com/')).ok).toBe(true) // suffix match must respect the dot
  })

  test('strictOrigin requires a matching Origin/Referer host', async () => {
    const { a } = make({ allowedHosts: ['example.com'], strictOrigin: true })
    const post = (h: Record<string, string>) =>
      a.handle(
        new Request('http://x/collect', {
          method: 'POST',
          body: '{"url":"https://example.com/"}',
          headers: { 'user-agent': UA, ...h },
        }),
      )
    expect((await post({ origin: 'https://example.com' })).status).toBe(202)
    expect((await post({ origin: 'https://www.example.com' })).status).toBe(202)
    expect((await post({ referer: 'https://example.com/page' })).status).toBe(202)
    expect((await post({ origin: 'https://evil.com' })).status).toBe(403)
    expect((await post({})).status).toBe(403)
    expect((await post({ origin: 'not a url' })).status).toBe(403)
  })
})

describe('onError', () => {
  test('is called for storage failures and a throwing logger is harmless', async () => {
    const seen: string[] = []
    const boom: EventStore = {
      insert: async () => {
        throw new Error('db down')
      },
      list: async () => [],
    }
    const a = createTallymark({
      store: boom,
      onError: (e, c) => {
        seen.push(`${c.where}:${(e as Error).message}`)
      },
    })
    expect((await a.track({ url: '/p', userAgent: UA })).ok).toBe(false)
    expect(seen).toEqual(['track:db down'])
    const b = createTallymark({
      store: boom,
      onError: () => {
        throw new Error('logger broke')
      },
    })
    expect(await b.track({ url: '/p', userAgent: UA })).toEqual({ ok: false, reason: 'storage' })
  })

  test('handler exceptions are reported, response stays generic', async () => {
    const seen: unknown[] = []
    const store: EventStore = {
      insert: async () => {},
      list: async () => {
        throw new Error('secret')
      },
    }
    const a = createTallymark({ store, apiKey: 'k', onError: (e) => seen.push(e) })
    const res = await a.handle(
      new Request('http://x/api/summary', { headers: { authorization: 'Bearer k' } }),
    )
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret')
    expect(seen.length).toBe(1)
  })
})

describe('third-party forwarding', () => {
  test('forward runs after storing, failures never fail the hit', async () => {
    const got: TallymarkEvent[] = []
    const { a } = make({ forward: (e: TallymarkEvent) => void got.push(e) })
    const r = await a.track({ url: 'https://example.com/', userAgent: UA })
    expect(r.ok && got[0]!.id === r.event.id).toBe(true)

    const errors: unknown[] = []
    const bad = createTallymark({
      forward: () => {
        throw new Error('hook down')
      },
      onError: (e) => errors.push(e),
    })
    expect((await bad.track({ url: '/p', userAgent: UA })).ok).toBe(true)
    expect(errors.length).toBe(1)
  })

  test('waitUntil defers forwarding off the hot path', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let delivered = false
    const a = createTallymark({
      forward: async () => {
        await gate
        delivered = true
      },
    })
    const bg: Promise<unknown>[] = []
    await a.track({ url: '/p', userAgent: UA }, { waitUntil: (p) => void bg.push(p) })
    expect(delivered).toBe(false) // response was not blocked
    release()
    await Promise.all(bg)
    expect(delivered).toBe(true)
  })

  test('webhookSink signs the body, retries 5xx, gives up on 4xx', async () => {
    const calls: { body: string; sig: string | null }[] = []
    let status = [503, 200]
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls.push({
        body: init.body as string,
        sig: (init.headers as Record<string, string>)['x-tallymark-signature'] ?? null,
      })
      return new Response(null, { status: status.shift() ?? 200 })
    }) as unknown as typeof fetch
    const { a } = make()
    const r = await a.track({ url: 'https://example.com/', userAgent: UA })
    const event = r.ok ? r.event : (undefined as never)

    const send = webhookSink({ url: 'https://hook.example', secret: 'shh', fetch: fetchImpl })
    await send(event)
    expect(calls.length).toBe(2) // 503 then 200
    expect(await verifyWebhookSignature('shh', calls[1]!.body, calls[1]!.sig)).toBe(true)
    expect(await verifyWebhookSignature('wrong', calls[1]!.body, calls[1]!.sig)).toBe(false)
    expect(await verifyWebhookSignature('shh', `${calls[1]!.body} `, calls[1]!.sig)).toBe(false)
    expect(await verifyWebhookSignature('shh', calls[1]!.body, null)).toBe(false)
    expect(JSON.parse(calls[1]!.body).event.id).toBe(event.id)

    calls.length = 0
    status = [400]
    await expect(send(event)).rejects.toThrow('400')
    expect(calls.length).toBe(1) // 4xx is not retried
  })
})

describe('backups', () => {
  test('mirrorStore copies to mirrors; mirror failure is reported but never fails the hit', async () => {
    const primary = memoryStore()
    const backup = memoryStore()
    const broken: EventStore = {
      insert: async () => {
        throw new Error('mirror down')
      },
      list: async () => [],
    }
    const errors: number[] = []
    const a = createTallymark({
      store: mirrorStore(primary, [backup, broken], { onError: (_e, i) => void errors.push(i) }),
    })
    expect((await a.track({ url: '/p', userAgent: UA })).ok).toBe(true)
    expect((await backup.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).length).toBe(1)
    expect(errors).toEqual([1])
  })

  test('primary failure fails the insert', async () => {
    const dead: EventStore = {
      insert: async () => {
        throw new Error('x')
      },
      list: async () => [],
    }
    const a = createTallymark({ store: mirrorStore(dead, memoryStore()) })
    expect(await a.track({ url: '/p', userAgent: UA })).toEqual({ ok: false, reason: 'storage' })
  })

  test('export -> import round trip restores everything, idempotently', async () => {
    const { a, hit } = make()
    await hit('1.1.1.1', '/a', T0, {
      country: 'DE',
      language: 'de',
      props: { n: 1 },
      value: 5,
      name: 'Buy',
    })
    await hit('2.2.2.2', '/b', T0 + MIN)
    const dump = await a.export('24h')
    expect(dump.trim().split('\n').length).toBe(2)

    const fresh = createTallymark({ now: () => T0 + 5 * MIN })
    expect(await fresh.import(dump)).toEqual({ imported: 2, skipped: 0 })
    expect(await fresh.import(dump)).toEqual({ imported: 2, skipped: 0 }) // dedupe by id
    expect((await fresh.events('24h')).length).toBe(2)
    expect(await fresh.events('24h')).toEqual(await a.events('24h'))
  })

  test('import rejects malformed or hostile lines without throwing', async () => {
    const a = createTallymark()
    const good = JSON.stringify({
      id: 'a',
      type: 'pageview',
      name: 'pageview',
      ts: T0,
      visitor: 'v',
      hostname: 'h',
      path: '/',
      referrer: null,
      referrerHost: null,
      utm: { source: null, medium: null, campaign: null, term: null, content: null },
      browser: null,
      browserVersion: null,
      os: null,
      osVersion: null,
      device: 'desktop',
      country: null,
      region: null,
      city: null,
      timezone: null,
      language: null,
      screen: null,
      props: {},
      value: null,
      duration: null,
      scroll: null,
    })
    const lines = [
      'not json',
      '{}',
      '[]',
      'null',
      '"str"',
      JSON.stringify({ id: 'x'.repeat(100) }),
      good.replace(`"ts":${T0}`, '"ts":"NaN"'),
      good,
      '',
      '  ',
    ]
    expect(await a.import(lines.join('\n'))).toEqual({ imported: 1, skipped: 7 })
    expect(isTallymarkEvent(JSON.parse(good))).toBe(true)
  })

  test('HTTP: NDJSON export and authenticated import', async () => {
    const { a, hit } = make()
    await hit('1.1.1.1', '/a')
    const auth = { authorization: 'Bearer k' }
    const dump = await (
      await a.handle(new Request('http://x/api/export.ndjson', { headers: auth }))
    ).text()
    expect(dump.trim().split('\n').length).toBe(1)

    const fresh = createTallymark({ apiKey: 'k' })
    const imp = (headers: Record<string, string>) =>
      fresh.handle(new Request('http://x/api/import', { method: 'POST', body: dump, headers }))
    expect((await imp({})).status).toBe(401)
    const ok = (await (await imp(auth)).json()) as any
    expect(ok.data).toEqual({ imported: 1, skipped: 0 })
    expect((await fresh.handle(new Request('http://x/api/import'))).status).toBe(405)
  })
})

describe('node adapter', () => {
  function fakeReq(method: string, url: string, headers: Record<string, string>, body = '') {
    const chunks = body ? [new TextEncoder().encode(body)] : []
    return {
      method,
      url,
      headers,
      socket: { remoteAddress: '5.5.5.5' },
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c
      },
    }
  }
  function fakeRes() {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' }
    return {
      out,
      res: {
        set statusCode(v: number) {
          out.status = v
        },
        get statusCode() {
          return out.status
        },
        setHeader: (k: string, v: string | string[]) => {
          out.headers[k] = String(v)
        },
        end: (c?: Uint8Array | string) => {
          out.body = typeof c === 'string' ? c : new TextDecoder().decode(c)
        },
      },
    }
  }

  test('bridges node req/res to the fetch handler, using the socket IP', async () => {
    const a = createTallymark({ apiKey: 'k', trustProxy: false, secret: 's' })
    const h = nodeHandler(a)
    const { res, out } = fakeRes()
    await h(
      fakeReq(
        'POST',
        '/collect',
        { host: 'x.test', 'user-agent': UA, 'content-type': 'text/plain' },
        '{"url":"https://example.com/"}',
      ) as any,
      res,
    )
    expect(out.status).toBe(202)

    const r2 = fakeRes()
    await h(
      fakeReq('GET', '/api/summary?range=24h', {
        host: 'x.test',
        authorization: 'Bearer k',
      }) as any,
      r2.res,
    )
    expect(JSON.parse(r2.out.body).data.pageviews).toBe(1)
    expect(r2.out.headers['content-type']).toContain('json')
  })

  test('express-style mount prefix via originalUrl + basePath', async () => {
    const a = createTallymark({ basePath: '/analytics' })
    const h = nodeHandler(a)
    const { res, out } = fakeRes()
    const req = {
      ...fakeReq('GET', '/health', { host: 'x.test' }),
      originalUrl: '/analytics/health',
    }
    await h(req as any, res)
    expect(out.status).toBe(200)
  })
})

describe('cloudflare geo', () => {
  test('request.cf supplies country/region/city and wins over headers', async () => {
    const w = cloudflare<{ k: string }>(() => ({ apiKey: 'k', secret: 's' }))
    const env = { k: 'k' }
    const req = new Request('http://x/collect', {
      method: 'POST',
      body: '{"url":"https://example.com/"}',
      headers: { 'user-agent': UA, 'cf-ipcountry': 'FR' },
    })
    ;(req as any).cf = { country: 'DE', region: 'Bavaria', city: 'Munich' }
    expect((await w.fetch(req, env)).status).toBe(202)
    const res = await w.fetch(
      new Request('http://x/api/events?range=24h', { headers: { authorization: 'Bearer k' } }),
      env,
    )
    const [e] = ((await res.json()) as any).data
    expect(e).toMatchObject({ country: 'DE', region: 'Bavaria', city: 'Munich' })
  })

  test('Tor / unknown country codes are not recorded', async () => {
    const w = cloudflare<{ k: string }>(() => ({ apiKey: 'k' }))
    for (const cc of ['XX', 'T1']) {
      const req = new Request('http://x/collect', {
        method: 'POST',
        body: '{"url":"https://example.com/"}',
        headers: { 'user-agent': UA },
      })
      ;(req as any).cf = { country: cc }
      await w.fetch(req, { k: 'k' })
    }
    const res = await w.fetch(
      new Request('http://x/api/events?range=24h', { headers: { authorization: 'Bearer k' } }),
      { k: 'k' },
    )
    expect(((await res.json()) as any).data.every((e: any) => e.country === null)).toBe(true)
  })
})

describe('nodeRequest', () => {
  test('builds a body-less Request from a Node request, safe after the body was consumed', async () => {
    const { nodeRequest, nodeConn } = await import('../src/node')
    const req = {
      method: 'post',
      url: '/subscribe',
      originalUrl: '/api/subscribe?x=1',
      headers: {
        host: 'shop.example',
        'user-agent': 'UA/1',
        'x-forwarded-proto': 'https',
        cookie: ['a=1', 'b=2'],
      },
      socket: { remoteAddress: '198.51.100.4' },
      [Symbol.asyncIterator]() {
        return {
          next() {
            throw new Error('the body must never be read')
          },
        }
      },
    }
    const r = nodeRequest(req as never)
    expect(r.url).toBe('https://shop.example/api/subscribe?x=1')
    expect(r.method).toBe('POST')
    expect(r.headers.get('user-agent')).toBe('UA/1')
    expect(nodeConn(req as never)).toEqual({ ip: '198.51.100.4' })
    expect(nodeConn(req as never, { trustProxy: true })).toEqual({ ip: undefined })
  })
})
