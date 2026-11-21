import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { Redis } from '@upstash/redis'
import { SQL } from 'bun'
import { Pool } from 'pg'
import type { EventStore, TallymarkEvent } from '../src'
import { createTallymark, memoryStore } from '../src'
import {
  bunSqliteStore,
  pgStore,
  postgresJsStore,
  upstashRestStore,
  upstashStore,
} from '../src/stores'

const T0 = Date.UTC(2026, 0, 10, 12)

const ev = (n: number, over: Partial<TallymarkEvent> = {}): TallymarkEvent => ({
  id: `id${n}`,
  type: 'pageview',
  name: 'pageview',
  ts: T0 + n * 1000,
  visitor: `v${n % 3}`,
  hostname: 'example.com',
  path: `/p${n}`,
  referrer: null,
  referrerHost: null,
  utm: { source: null, medium: null, campaign: null, term: null, content: null },
  browser: 'Chrome',
  browserVersion: '130',
  os: 'Windows',
  osVersion: null,
  device: 'desktop',
  screen: null,
  timezone: null,
  duration: null,
  scroll: null,
  country: 'US',
  region: null,
  city: null,
  language: null,
  props: {},
  value: null,
  ...over,
})

/** A faithful in-memory sorted set implementing the Redis commands we use. */
class FakeZSet {
  items: { score: number; member: string }[] = []
  zadd(score: number, member: string) {
    this.items = this.items.filter((i) => i.member !== member)
    this.items.push({ score, member })
    return 1
  }
  private bound(v: string | number): { n: number; excl: boolean } {
    if (v === '-inf') return { n: -Infinity, excl: false }
    if (v === '+inf') return { n: Infinity, excl: false }
    const s = String(v)
    return s.startsWith('(') ? { n: Number(s.slice(1)), excl: true } : { n: Number(s), excl: false }
  }
  /** `ZRANGE key a b BYSCORE REV LIMIT 0 count`: a is the max, b is the min. */
  rangeRev(a: string | number, b: string | number, count: number) {
    const max = this.bound(a)
    const min = this.bound(b)
    return this.items
      .filter(
        (i) =>
          (min.excl ? i.score > min.n : i.score >= min.n) &&
          (max.excl ? i.score < max.n : i.score <= max.n),
      )
      .sort((x, y) => y.score - x.score)
      .slice(0, count)
      .map((i) => i.member)
  }
  remBelow(min: string | number, max: string | number) {
    const lo = this.bound(min)
    const hi = this.bound(max)
    const before = this.items.length
    this.items = this.items.filter(
      (i) =>
        !(
          (lo.excl ? i.score > lo.n : i.score >= lo.n) &&
          (hi.excl ? i.score < hi.n : i.score <= hi.n)
        ),
    )
    return before - this.items.length
  }
}

function fakeUpstashSdk(autoParse: boolean) {
  const z = new FakeZSet()
  return {
    zadd: async (_k: string, m: { score: number; member: string }) => z.zadd(m.score, m.member),
    // The real SDK auto-deserialises JSON members; mimic both behaviours.
    zrange: async (
      _k: string,
      max: number | string,
      min: number | string,
      opts: { count: number },
    ) => z.rangeRev(max, min, opts.count).map((m) => (autoParse ? JSON.parse(m) : m)),
    zremrangebyscore: async (_k: string, min: number | string, max: number | string) =>
      z.remBelow(min, max),
  }
}

function fakeUpstashRest() {
  const z = new FakeZSet()
  const calls: unknown[][] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    const [cmd, ...a] = JSON.parse(init.body as string) as [string, ...any[]]
    calls.push([cmd, ...a])
    let result: unknown
    if (cmd === 'ZADD') result = z.zadd(a[1], a[2])
    else if (cmd === 'ZRANGE') result = z.rangeRev(a[1], a[2], a[a.indexOf('LIMIT') + 2])
    else if (cmd === 'ZREMRANGEBYSCORE') result = z.remBelow(a[1], a[2])
    else return Response.json({ error: `unknown ${cmd}` }, { status: 400 })
    return Response.json({ result })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const factories: [string, () => EventStore | Promise<EventStore>][] = [
  ['memory', () => memoryStore()],
  ['bun:sqlite', () => bunSqliteStore(new Database(':memory:'))],
  ['postgres (PGlite)', () => pgStore(new PGlite())],
  [
    'postgres.js shape',
    () => {
      const db = new PGlite()
      return postgresJsStore({
        // postgres.js returns the rows array with a `count` property.
        unsafe: async (text, params) => {
          const r = await db.query(text, params)
          return Object.assign([...r.rows], { count: r.affectedRows ?? 0 })
        },
      })
    },
  ],
  [
    'neon shape (rows array)',
    () => {
      const db = new PGlite()
      return pgStore({ query: async (t, p) => (await db.query(t, p)).rows })
    },
  ],
  ['upstash sdk (auto-parse)', () => upstashStore(fakeUpstashSdk(true))],
  ['upstash sdk (strings)', () => upstashStore(fakeUpstashSdk(false))],
  [
    'upstash rest (fetch)',
    () =>
      upstashRestStore({
        url: 'https://x.upstash.io',
        token: 'tok',
        fetch: fakeUpstashRest().fetchImpl,
      }),
  ],
]

// Real services. Set by docker compose / CI; skipped when absent so `bun test` needs no Docker.
//   TM_PG_URL=postgres://postgres:pw@127.0.0.1:55432/stats
//   TM_UPSTASH_URL=http://127.0.0.1:58079 TM_UPSTASH_TOKEN=tok   (serverless-redis-http in front of Redis)
const PG_URL = process.env.TM_PG_URL
const UP_URL = process.env.TM_UPSTASH_URL
const UP_TOKEN = process.env.TM_UPSTASH_TOKEN ?? 'tok'
const freshKey = () => `test:${crypto.randomUUID()}`

if (PG_URL) {
  const reset = async () => {
    const pool = new Pool({ connectionString: PG_URL })
    await pool.query('DROP TABLE IF EXISTS tallymark_events')
    return pool
  }
  factories.push(
    ['REAL postgres via pg', async () => pgStore(await reset())],
    [
      'REAL postgres via Bun.SQL',
      async () => {
        await (await reset()).end()
        return postgresJsStore(new SQL(PG_URL))
      },
    ],
  )
}
if (UP_URL) {
  factories.push(
    [
      'REAL redis via upstashRestStore',
      () => upstashRestStore({ url: UP_URL, token: UP_TOKEN, key: freshKey() }),
    ],
    [
      'REAL redis via @upstash/redis SDK',
      () => upstashStore(new Redis({ url: UP_URL, token: UP_TOKEN }), { key: freshKey() }),
    ],
  )
}

describe.each(factories)('EventStore contract: %s', (_name, make) => {
  test('list is [from, to) and oldest-first', async () => {
    const s = await make()
    for (const n of [3, 1, 2, 0, 4]) await s.insert(ev(n))
    const got = await s.list({ from: T0 + 1000, to: T0 + 4000 })
    expect(got.map((e) => e.id)).toEqual(['id1', 'id2', 'id3'])
  })

  test('limit keeps the newest rows, still oldest-first', async () => {
    const s = await make()
    for (let n = 0; n < 10; n++) await s.insert(ev(n))
    const got = await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 3 })
    expect(got.map((e) => e.id)).toEqual(['id7', 'id8', 'id9'])
  })

  test('round-trips every field exactly', async () => {
    const s = await make()
    const full = ev(1, {
      type: 'event',
      name: 'Purchase',
      referrer: 'hn.com/x',
      referrerHost: 'hn.com',
      utm: { source: 'hn', medium: 'post', campaign: 'launch', term: 't', content: 'c' },
      region: 'CA',
      city: 'São Paulo',
      props: { plan: 'pro', n: 3, ok: true },
      value: 49.5,
      browserVersion: '130',
      osVersion: '17',
      screen: 'laptop',
      timezone: 'Europe/Berlin',
      language: 'de-DE',
    })
    // An engagement beacon carries time on page and scroll depth.
    const engagement = ev(2, {
      type: 'engagement',
      name: 'engagement',
      duration: 31_500,
      scroll: 80,
    })
    await s.insert(engagement)
    await s.insert(full)
    expect(await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).toEqual([full, engagement])
  })

  test('empty range and null/zero values', async () => {
    const s = await make()
    expect(await s.list({ from: 0, to: 1 })).toEqual([])
    await s.insert(ev(1, { value: 0 }))
    expect((await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER }))[0]!.value).toBe(0)
  })

  test('re-inserting the same event does not duplicate it', async () => {
    const s = await make()
    await s.insert(ev(1))
    await s.insert(ev(1))
    expect((await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).length).toBe(1)
  })

  test('prune removes only older rows and reports the count', async () => {
    const s = await make()
    for (let n = 0; n < 5; n++) await s.insert(ev(n))
    expect(await s.prune!(T0 + 2000)).toBe(2) // id0, id1; boundary row id2 stays
    expect((await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).map((e) => e.id)).toEqual([
      'id2',
      'id3',
      'id4',
    ])
  })

  test('works end to end through the engine', async () => {
    const a = createTallymark({ store: await make(), now: () => T0 + 60_000 })
    const UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
    await a.track({
      url: 'https://example.com/x',
      ip: '1.1.1.1',
      userAgent: UA,
      ts: T0,
      country: 'FR',
    })
    await a.track({
      name: 'Buy',
      url: 'https://example.com/x',
      ip: '1.1.1.1',
      userAgent: UA,
      ts: T0 + 1000,
      value: 10,
    })
    expect(await a.summary('1h')).toMatchObject({
      pageviews: 1,
      events: 1,
      visitors: 1,
      sessions: 1,
    })
    expect((await a.top('country', '1h'))[0]).toMatchObject({ key: 'FR' })
    expect((await a.top('event', '1h'))[0]).toMatchObject({ key: 'Buy', value: 10 })
  })
})

describe('postgres specifics', () => {
  test('concurrent cold start does not blow up the schema', async () => {
    const s = pgStore(new PGlite())
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.insert(ev(i))))
    expect((await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).length).toBe(10)
  })

  test('schema race: a lost CREATE TABLE is tolerated when the table exists', async () => {
    const db = new PGlite()
    await pgStore(db).list({ from: 0, to: 1 }) // another instance already created the real table
    const s = pgStore({
      query: async (t, p) => {
        if (t.startsWith('CREATE'))
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          })
        return db.query(t, p)
      },
    })
    await s.insert(ev(1))
    expect((await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).length).toBe(1)
  })

  test('a genuinely broken database still surfaces as a storage failure', async () => {
    const a = createTallymark({
      store: pgStore({
        query: async () => {
          throw new Error('connection refused')
        },
      }),
    })
    expect(
      await a.track({
        url: '/p',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36',
      }),
    ).toEqual({ ok: false, reason: 'storage' })
  })

  test('SQL injection via event fields is inert (parameterised)', async () => {
    const s = pgStore(new PGlite())
    await s.insert(
      ev(1, {
        path: "/'; DROP TABLE tallymark_events; --",
        name: "x'); DELETE FROM tallymark_events; --",
        props: { a: "' OR 1=1 --" },
      }),
    )
    const [e] = await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })
    expect(e!.path).toBe("/'; DROP TABLE tallymark_events; --")
  })
})

describe('upstash specifics', () => {
  test('REST store sends well-formed commands with an exclusive upper bound', async () => {
    const { fetchImpl, calls } = fakeUpstashRest()
    const s = upstashRestStore({ url: 'https://x', token: 'tok', fetch: fetchImpl, key: 'k1' })
    await s.insert(ev(1))
    await s.list({ from: 10, to: 20, limit: 5 })
    await s.prune!(15)
    expect(calls[0]!.slice(0, 3)).toEqual(['ZADD', 'k1', T0 + 1000])
    expect(calls[1]).toEqual(['ZRANGE', 'k1', '(20', 10, 'BYSCORE', 'REV', 'LIMIT', 0, 5])
    expect(calls[2]).toEqual(['ZREMRANGEBYSCORE', 'k1', '-inf', '(15'])
  })

  test('REST errors and HTTP failures surface as store failures, not silent loss', async () => {
    const bad = upstashRestStore({
      url: 'https://x',
      token: 'tok',
      fetch: (async () =>
        Response.json({ error: 'WRONGPASS' }, { status: 401 })) as unknown as typeof fetch,
    })
    await expect(bad.insert(ev(1))).rejects.toThrow('upstash: WRONGPASS')
    const a = createTallymark({ store: bad })
    expect(
      await a.track({
        url: '/p',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36',
      }),
    ).toEqual({ ok: false, reason: 'storage' })
  })

  test('corrupt members are skipped, not fatal', async () => {
    const z = new FakeZSet()
    z.zadd(T0, 'not json')
    z.zadd(T0 + 1, JSON.stringify(ev(1)))
    const s = upstashStore({
      zadd: async () => 1,
      zrange: async (_k, max, min, opts) => z.rangeRev(max, min, opts.count),
      zremrangebyscore: async () => 0,
    })
    expect((await s.list({ from: 0, to: Number.MAX_SAFE_INTEGER })).length).toBe(1)
  })
})
