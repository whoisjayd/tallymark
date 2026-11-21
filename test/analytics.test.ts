import { describe, expect, test } from 'bun:test'
import { createTallymark } from '../src'
import { continentOf, geoFromHeaders, screenClass, timezone } from '../src/hit'
import { vercel, vercelCron } from '../src/vercel'

const WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

const T0 = Date.UTC(2026, 0, 10, 12) // a Saturday, 12:00 UTC
const SEC = 1000
const MIN = 60_000

function setup(options = {}) {
  let t = T0
  const tm = createTallymark({ secret: 's', apiKey: 'k', now: () => t, ...options })
  /** Record a hit at a time. Moving the clock forward keeps later queries ("24h") covering it. */
  const hit = (ip: string, ua: string, url: string, at = t, more: Record<string, unknown> = {}) => {
    t = Math.max(t, at)
    return tm.track({ url: `https://example.com${url}`, ip, userAgent: ua, ts: at, ...more })
  }
  const api = async (path: string) =>
    (await (
      await tm.handle(new Request(`http://x${path}`, { headers: { authorization: 'Bearer k' } }))
    ).json()) as any
  return {
    tm,
    hit,
    api,
    at: (ms: number) => {
      t = ms
    },
  }
}

describe('every dimension resolves', () => {
  async function world() {
    const w = setup()
    await w.hit('1.1.1.1', WIN, '/', T0, {
      country: 'DE',
      region: 'Berlin',
      city: 'Berlin',
      timezone: 'Europe/Berlin',
      language: 'de-DE',
      screenWidth: 1920,
      referrer: 'https://www.google.de/search',
    })
    await w.hit('2.2.2.2', IPHONE, '/pricing', T0, {
      country: 'US',
      region: 'CA',
      city: 'San Francisco',
      timezone: 'America/Los_Angeles',
      language: 'en-US',
      screenWidth: 390,
      referrer: 'https://t.co/abc',
    })
    await w.hit(
      '3.3.3.3',
      PIXEL,
      '/blog?utm_source=newsletter&utm_medium=email&utm_term=shoes&utm_content=hero',
      T0,
      { country: 'BR', language: 'pt-BR', screenWidth: 800 },
    )
    await w.hit('4.4.4.4', WIN, '/?utm_source=google&utm_medium=cpc&utm_campaign=spring', T0, {
      country: 'JP',
      screenWidth: 1280,
    })
    w.at(T0 + MIN)
    return w
  }

  test.each([
    ['path', ['/', '/blog', '/pricing']],
    ['referrer', ['google.de', 't.co']],
    ['source', ['google', 'google.de', 'newsletter', 't.co']],
    ['channel', ['Email', 'Organic Search', 'Paid', 'Social']],
    ['country', ['BR', 'DE', 'JP', 'US']],
    ['continent', ['Asia', 'Europe', 'North America', 'South America']],
    ['region', ['Berlin', 'CA']],
    ['city', ['Berlin', 'San Francisco']],
    ['timezone', ['America/Los_Angeles', 'Europe/Berlin']],
    ['language', ['de-DE', 'en-US', 'pt-BR']],
    ['browser', ['Chrome', 'Safari']],
    ['browser_version', ['Chrome 130', 'Safari 17']],
    ['os', ['Android', 'Windows', 'iOS']],
    ['os_version', ['Android 14', 'iOS 17']],
    ['device', ['desktop', 'mobile']],
    ['screen', ['desktop', 'laptop', 'mobile', 'tablet']],
    ['utm_source', ['google', 'newsletter']],
    ['utm_medium', ['cpc', 'email']],
    ['utm_campaign', ['spring']],
    ['utm_term', ['shoes']],
    ['utm_content', ['hero']],
    ['hostname', ['example.com']],
    ['weekday', ['Sat']],
    ['hour', ['12']],
  ] as const)('top by %s', async (dimension, expected) => {
    const { tm } = await world()
    const keys = (await tm.top(dimension, '24h', {}, 100)).map((r) => r.key).sort()
    expect(keys).toEqual([...expected].sort())
  })

  test('every dimension is also a filter', async () => {
    const { tm } = await world()
    expect((await tm.summary('24h', { continent: 'Europe' })).pageviews).toBe(1)
    expect((await tm.summary('24h', { channel: 'Paid' })).pageviews).toBe(1)
    expect((await tm.summary('24h', { screen: 'mobile', os_version: 'iOS 17' })).pageviews).toBe(1)
    expect((await tm.summary('24h', { weekday: 'Sat' })).pageviews).toBe(4)
    expect((await tm.summary('24h', { weekday: 'Mon' })).pageviews).toBe(0)
  })

  test('the HTTP API lists every dimension', async () => {
    const { api } = await world()
    for (const by of [
      'continent',
      'channel',
      'source',
      'screen',
      'weekday',
      'utm_term',
      'browser_version',
      'entry_page',
      'exit_page',
    ]) {
      expect((await api(`/api/top?by=${by}&range=24h`)).ok).toBe(true)
    }
    expect((await api('/api/top?by=nonsense')).ok).toBe(false)
  })
})

describe('acquisition channels', () => {
  const channelOf = async (url: string, referrer?: string) => {
    const { tm, hit } = setup()
    await hit('1.1.1.1', WIN, url, T0, { referrer })
    return (await tm.top('channel', '24h'))[0]?.key
  }

  test.each([
    ['/', undefined, 'Direct'],
    ['/', 'https://blog.example.org/post', 'Referral'],
    ['/', 'https://www.google.com/', 'Organic Search'],
    ['/', 'https://www.google.co.uk/', 'Organic Search'],
    ['/', 'https://duckduckgo.com/', 'Organic Search'],
    ['/', 'https://news.ycombinator.com/item?id=1', 'Social'],
    ['/', 'https://x.com/someone', 'Social'],
    ['/', 'https://l.facebook.com/', 'Social'],
    ['/?utm_medium=social', undefined, 'Social'],
    ['/?utm_medium=email', undefined, 'Email'],
    ['/?utm_source=newsletter', undefined, 'Email'],
    ['/?utm_medium=cpc&utm_source=google', 'https://www.google.com/', 'Paid'], // paid beats the search referrer
    ['/?utm_campaign=launch', undefined, 'Campaign'],
    ['/', 'https://notgoogle.example/', 'Referral'], // "google" must be a whole host label
    ['/', 'https://google.evil.com/', 'Referral'], // a lookalike is not Google
    ['/', 'https://www.facebook.evil.com/', 'Referral'],
    ['/', 'https://www.google.com.au/', 'Organic Search'],
  ] as const)('%s from %s is %s', async (url, referrer, expected) => {
    expect(await channelOf(url, referrer)).toBe(expected)
  })
})

describe('custom property dimensions', () => {
  async function signups() {
    const w = setup()
    for (const [ip, plan, value] of [
      ['1.1.1.1', 'pro', 49],
      ['2.2.2.2', 'pro', 49],
      ['3.3.3.3', 'free', 0],
      ['4.4.4.4', 'team', 99],
    ] as const) {
      await w.hit(ip, WIN, '/signup', T0, {
        name: 'Signup',
        props: { plan, seats: plan === 'team' ? 5 : 1 },
        value,
      })
    }
    w.at(T0 + MIN)
    return w
  }

  test('break an event down by any property, with revenue', async () => {
    const { tm } = await signups()
    // A property lives on events, so grouping by it counts events and sums their values.
    expect(await tm.top('prop:plan', '24h', { event: 'Signup' })).toEqual([
      { key: 'pro', visitors: 2, count: 2, value: 98 },
      { key: 'free', visitors: 1, count: 1, value: 0 },
      { key: 'team', visitors: 1, count: 1, value: 99 },
    ])
    // ...and a property can be a filter on the event itself.
    expect(await tm.top('event', '24h', { 'prop:plan': 'pro' })).toEqual([
      { key: 'Signup', visitors: 2, count: 2, value: 98 },
    ])
  })

  test('numeric properties are matched as strings', async () => {
    const { tm } = await signups()
    expect((await tm.top('event', '24h', { 'prop:seats': '5' }))[0]).toMatchObject({
      count: 1,
      value: 99,
    })
  })

  test('over HTTP: filter by prop and group by prop', async () => {
    const { api } = await signups()
    const filtered = await api('/api/top?by=event&range=24h&prop:plan=free')
    expect(filtered.data).toEqual([{ key: 'Signup', visitors: 1, count: 1, value: 0 }])
    expect((await api('/api/top?by=prop:plan&range=24h')).data[0]).toMatchObject({
      key: 'pro',
      count: 2,
      value: 98,
    })
    expect((await api('/api/top?by=prop:bad name&range=24h')).ok).toBe(false)
  })
})

describe('attribution of events', () => {
  test('a purchase inherits the visitor first source, so revenue by source and channel works', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', T0, { referrer: 'https://news.ycombinator.com/' })
    await hit('1.1.1.1', WIN, '/buy', T0 + 5 * SEC, { name: 'Purchase', value: 49 })
    await hit('2.2.2.2', WIN, '/', T0) // direct visitor, never buys
    at(T0 + MIN)
    expect(await tm.top('event', '24h', { source: 'news.ycombinator.com' })).toEqual([
      { key: 'Purchase', visitors: 1, count: 1, value: 49 },
    ])
    expect(await tm.top('event', '24h', { channel: 'Social' })).toHaveLength(1)
    expect(await tm.top('event', '24h', { channel: 'Direct' })).toHaveLength(0)
  })
})

describe('attribution lasts for the session', () => {
  test('later pages inherit the entry source, so one visitor from Google is one Google visitor', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', T0, { referrer: 'https://www.google.com/' })
    await hit('1.1.1.1', WIN, '/pricing', T0 + 10 * SEC)
    await hit('1.1.1.1', WIN, '/signup', T0 + 20 * SEC)
    at(T0 + MIN)
    expect(await tm.top('channel', '24h')).toEqual([
      { key: 'Organic Search', visitors: 1, count: 3 },
    ])
    expect((await tm.top('source', '24h'))[0]).toMatchObject({ key: 'google.com', count: 3 })
  })

  test('a new session after 30 minutes of inactivity does not inherit the old source', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', T0, { referrer: 'https://www.google.com/' })
    await hit('1.1.1.1', WIN, '/back', T0 + 45 * MIN) // returns directly, later
    at(T0 + 60 * MIN)
    const channels = (await tm.top('channel', '24h')).map((r) => r.key).sort()
    expect(channels).toEqual(['Direct', 'Organic Search'])
  })

  test('a hit that brings its own campaign replaces the inherited source', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', T0, { referrer: 'https://www.google.com/' })
    await hit('1.1.1.1', WIN, '/landing?utm_medium=email&utm_source=newsletter', T0 + 5 * MIN)
    await hit('1.1.1.1', WIN, '/next', T0 + 6 * MIN)
    at(T0 + 10 * MIN)
    const rows = await tm.top('channel', '24h')
    expect(rows.find((r) => r.key === 'Email')!.count).toBe(2) // the landing and the page after it
    expect(rows.find((r) => r.key === 'Organic Search')!.count).toBe(1)
  })

  test('visitors stay separate: a source never leaks from one person to another', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', T0, { referrer: 'https://www.google.com/' })
    await hit('2.2.2.2', WIN, '/', T0 + SEC) // a different person, direct
    at(T0 + MIN)
    const rows = await tm.top('channel', '24h')
    expect(rows.map((r) => [r.key, r.visitors]).sort()).toEqual([
      ['Direct', 1],
      ['Organic Search', 1],
    ])
  })
})

describe('revenue and time buckets', () => {
  test('revenue is summed from event values and compared across periods', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', T0 - 25 * 3_600_000, { name: 'Purchase', value: 10 }) // previous 24h
    await hit('1.1.1.1', WIN, '/', T0 - MIN, { name: 'Purchase', value: 30.5 })
    await hit('2.2.2.2', WIN, '/', T0 - MIN, { name: 'Purchase', value: 20 })
    at(T0)
    const s = await tm.summary('24h')
    expect(s.revenue).toBe(50.5)
    expect((await tm.compare('24h')).delta.revenue).toEqual({
      current: 50.5,
      previous: 10,
      change: 4.05,
    })
  })

  test('week buckets start on Monday, month buckets on the 1st', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/', Date.UTC(2026, 0, 10, 9)) // Saturday 10 Jan
    await hit('1.1.1.1', WIN, '/', Date.UTC(2026, 1, 20, 9)) // Friday 20 Feb
    at(Date.UTC(2026, 2, 31))
    const range = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 2, 31) }
    const weeks = await tm.timeseries(range, {}, 'week')
    expect(weeks.every((p) => new Date(p.t).getUTCDay() === 1)).toBe(true)
    expect(weeks.find((p) => p.pageviews)!.t).toBe(Date.UTC(2026, 0, 5)) // Monday 5 Jan
    const months = await tm.timeseries(range, {}, 'month')
    expect(months.map((p) => [new Date(p.t).toISOString().slice(0, 10), p.pageviews])).toEqual([
      ['2026-01-01', 1],
      ['2026-02-01', 1],
      ['2026-03-01', 0],
    ])
  })

  test('the default interval widens with the range, and never allocates unbounded buckets', async () => {
    const { tm } = setup()
    expect((await tm.timeseries('24h')).length).toBeLessThanOrEqual(25) // hourly
    expect((await tm.timeseries('90d')).length).toBeLessThanOrEqual(91) // daily
    expect((await tm.timeseries('365d')).length).toBeLessThanOrEqual(54) // weekly
    expect((await tm.timeseries({ from: 0, to: T0 }, {}, 'hour')).length).toBeLessThanOrEqual(2001)
  })

  test('HTTP accepts week and month', async () => {
    const { api } = setup()
    expect((await api('/api/timeseries?range=365d&interval=month')).data.length).toBeGreaterThan(10)
  })
})

describe('time on page', () => {
  /** Alice reads /a for 40s (scrolled 60%), then /b for 20s. Bob bounces off /a. */
  async function reading() {
    const w = setup()
    await w.hit('1.1.1.1', WIN, '/a', T0)
    await w.hit('1.1.1.1', WIN, '/a', T0 + 40 * SEC, {
      name: 'engagement',
      duration: 40_000,
      scroll: 60,
    })
    await w.hit('1.1.1.1', WIN, '/b', T0 + 41 * SEC)
    await w.hit('1.1.1.1', WIN, '/b', T0 + 61 * SEC, {
      name: 'engagement',
      duration: 20_000,
      scroll: 100,
    })
    await w.hit('2.2.2.2', WIN, '/a', T0)
    await w.hit('2.2.2.2', WIN, '/a', T0 + 10 * SEC, {
      name: 'engagement',
      duration: 10_000,
      scroll: 20,
    })
    w.at(T0 + 2 * MIN)
    return w
  }

  test('engagement beacons are not pageviews or events, and do not change bounce', async () => {
    const { tm } = await reading()
    const s = await tm.summary('24h')
    expect(s).toMatchObject({ pageviews: 3, events: 0, visitors: 2, sessions: 2, bounceRate: 0.5 })
    expect((await tm.realtime()).pageviews).toBe(3)
    expect((await tm.timeseries('24h')).reduce((n, p) => n + p.events, 0)).toBe(0)
  })

  test('average time on page and session length use the engaged time, including the last page', async () => {
    const { tm } = await reading()
    const s = await tm.summary('24h')
    expect(s.avgTimeOnPageSeconds).toBe(23) // (40 + 20 + 10) / 3
    expect(s.avgSessionSeconds).toBe(36) // alice 61s, bob 10s
  })

  test('top pages carry average time and scroll depth', async () => {
    const { tm } = await reading()
    const rows = await tm.top('path', '24h')
    expect(rows.find((r) => r.key === '/a')).toMatchObject({ count: 2, seconds: 25, scroll: 40 })
    expect(rows.find((r) => r.key === '/b')).toMatchObject({ count: 1, seconds: 20, scroll: 100 })
  })

  test('without the tracker, time on page falls back to the gap to the next hit', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/a', T0)
    await hit('1.1.1.1', WIN, '/b', T0 + 30 * SEC)
    at(T0 + MIN)
    const rows = await tm.top('path', '24h')
    expect(rows.find((r) => r.key === '/a')!.seconds).toBe(30)
    expect(rows.find((r) => r.key === '/b')!.seconds).toBeUndefined() // last page: unknown
  })

  test('a later beacon for the same page replaces an earlier one (cumulative)', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/a', T0)
    await hit('1.1.1.1', WIN, '/a', T0 + 10 * SEC, {
      name: 'engagement',
      duration: 10_000,
      scroll: 30,
    })
    await hit('1.1.1.1', WIN, '/a', T0 + 90 * SEC, {
      name: 'engagement',
      duration: 25_000,
      scroll: 90,
    })
    at(T0 + 2 * MIN)
    expect((await tm.top('path', '24h'))[0]).toMatchObject({ seconds: 25, scroll: 90 })
  })

  test('engagement is validated and capped', async () => {
    const { tm } = setup()
    const base = { url: 'https://example.com/a', userAgent: WIN, ip: '1.1.1.1', name: 'engagement' }
    expect(await tm.track(base)).toEqual({ ok: false, reason: 'invalid' }) // no duration
    expect(await tm.track({ ...base, duration: Number.NaN })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    const capped = await tm.track({ ...base, duration: 999_999_999, scroll: 250 })
    expect(capped.ok && [capped.event.duration, capped.event.scroll]).toEqual([14_400_000, 100])
    const floored = await tm.track({ ...base, duration: -5, scroll: -3 })
    expect(floored.ok && [floored.event.duration, floored.event.scroll]).toEqual([0, 0])
  })

  test('over HTTP, from the tracker payload', async () => {
    const { tm, api, at } = setup()
    const post = (b: unknown) =>
      tm.handle(
        new Request('http://x/collect', {
          method: 'POST',
          body: JSON.stringify(b),
          headers: { 'user-agent': WIN, 'x-forwarded-for': '9.9.9.9' },
        }),
      )
    await post({ url: 'https://example.com/a', w: 1500 })
    await post({ name: 'engagement', url: 'https://example.com/a', d: 12_000, s: 75, w: 1500 })
    at(T0 + MIN)
    const rows = (await api('/api/top?by=path&range=24h')).data
    expect(rows[0]).toMatchObject({ key: '/a', seconds: 12, scroll: 75 })
    expect((await api('/api/top?by=screen&range=24h')).data[0].key).toBe('desktop')
  })
})

describe('session traces and journeys', () => {
  async function traffic() {
    const w = setup()
    // Every hit of a visitor carries the same geo and device, as in real traffic.
    const alice = { country: 'DE' }
    // Alice: / -> /pricing -> reload -> /signup, then a Signup event worth 49.
    await w.hit('1.1.1.1', WIN, '/', T0, { ...alice, referrer: 'https://www.google.com/' })
    await w.hit('1.1.1.1', WIN, '/', T0 + 20 * SEC, {
      ...alice,
      name: 'engagement',
      duration: 18_000,
      scroll: 40,
    })
    await w.hit('1.1.1.1', WIN, '/pricing', T0 + 21 * SEC, alice)
    await w.hit('1.1.1.1', WIN, '/pricing', T0 + 30 * SEC, alice) // reload
    await w.hit('1.1.1.1', WIN, '/signup', T0 + 50 * SEC, alice)
    await w.hit('1.1.1.1', WIN, '/signup', T0 + 80 * SEC, {
      ...alice,
      name: 'Signup',
      value: 49,
      props: { plan: 'pro' },
    })
    // Bob: / -> /pricing
    await w.hit('2.2.2.2', IPHONE, '/', T0 + 10 * SEC)
    await w.hit('2.2.2.2', IPHONE, '/pricing', T0 + 25 * SEC)
    // Carol: / only
    await w.hit('3.3.3.3', PIXEL, '/', T0 + 15 * SEC)
    w.at(T0 + 5 * MIN)
    return w
  }

  test('a session is the ordered trail of pages and events, with time and scroll per page', async () => {
    const { tm } = await traffic()
    const alice = (await tm.sessions('24h', { country: 'DE' }))[0]!
    expect(alice).toMatchObject({
      entry: '/',
      exit: '/signup',
      pages: 4,
      revenue: 49,
      source: 'google.com',
      channel: 'Organic Search',
      country: 'DE',
      device: 'desktop',
    })
    expect(alice.seconds).toBe(80)
    expect(alice.steps.map((s) => [s.type, s.path, s.name])).toEqual([
      ['pageview', '/', undefined],
      ['pageview', '/pricing', undefined],
      ['pageview', '/pricing', undefined], // the reload is a real hit
      ['pageview', '/signup', undefined],
      ['event', '/signup', 'Signup'],
    ])
    expect(alice.steps[0]).toMatchObject({ seconds: 18, scroll: 40 }) // engaged time and scroll, from the beacon
    expect(alice.steps[1]).toMatchObject({ seconds: 9 }) // no beacon: time to the next hit
    expect(alice.steps[4]).toMatchObject({ value: 49 })
    expect(alice.steps.some((s) => (s as { type: string }).type === 'engagement')).toBe(false)
  })

  test('sessions come newest first, honour limit, and carry device and source', async () => {
    const { tm } = await traffic()
    const all = await tm.sessions('24h')
    expect(all).toHaveLength(3)
    expect(all.map((s) => s.start)).toEqual([...all.map((s) => s.start)].sort((a, b) => b - a))
    expect(await tm.sessions('24h', {}, 2)).toHaveLength(2)
    const bob = all.find((s) => s.os === 'iOS')!
    expect(bob).toMatchObject({
      os: 'iOS',
      channel: 'Direct',
      source: 'Direct',
      entry: '/',
      exit: '/pricing',
    })
  })

  test('30 minutes of inactivity splits one visitor into two sessions', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/a', T0)
    await hit('1.1.1.1', WIN, '/b', T0 + 31 * MIN)
    at(T0 + 40 * MIN)
    const sessions = await tm.sessions('24h')
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.entry).sort()).toEqual(['/a', '/b'])
  })

  test('long reading time keeps a session alive', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/long', T0)
    await hit('1.1.1.1', WIN, '/long', T0 + 25 * MIN, { name: 'engagement', duration: 1_500_000 })
    await hit('1.1.1.1', WIN, '/next', T0 + 50 * MIN) // 25 min after the last activity, not 50 after the first
    at(T0 + 60 * MIN)
    expect(await tm.sessions('24h')).toHaveLength(1)
  })

  test('a read longer than the session gap stays one visit and keeps its time', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', WIN, '/long', T0)
    await hit('1.1.1.1', WIN, '/long', T0 + 45 * MIN, { name: 'engagement', duration: 45 * MIN })
    await hit('1.1.1.1', WIN, '/next', T0 + 50 * MIN)
    at(T0 + 60 * MIN)
    const sessions = await tm.sessions('24h')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.steps[0]).toMatchObject({ path: '/long', seconds: 45 * 60 })
    expect(sessions[0]!.exit).toBe('/next')
  })

  test('journeys count the most common first pages, ignoring reloads', async () => {
    const { tm } = await traffic()
    const j = await tm.journeys('24h', {}, { depth: 3 })
    // All three journeys are equally common; ties are ordered alphabetically, so the result is stable.
    expect(j).toEqual([
      { steps: ['/'], sessions: 1, share: 0.3333 },
      { steps: ['/', '/pricing'], sessions: 1, share: 0.3333 },
      { steps: ['/', '/pricing', '/signup'], sessions: 1, share: 0.3333 },
    ])
    expect((await tm.journeys('24h', {}, { depth: 1 }))[0]).toEqual({
      steps: ['/'],
      sessions: 3,
      share: 1,
    })
  })

  test('over HTTP', async () => {
    const { api } = await traffic()
    const s = await api('/api/sessions?range=24h&limit=2')
    expect(s.data).toHaveLength(2)
    expect(s.data[0].steps[0]).toHaveProperty('path')
    const j = await api('/api/journeys?range=24h&depth=2&limit=5')
    expect(j.data[0]).toMatchObject({ steps: ['/', '/pricing'], sessions: 2 })
    expect((await api('/api/sessions?range=24h&limit=abc')).ok).toBe(true)
    expect((await api('/api/sessions?range=nope')).ok).toBe(false)
  })
})

describe('location and device helpers', () => {
  test('screen classes', () => {
    expect([320, 767, 768, 1023, 1024, 1439, 1440, 3840].map(screenClass)).toEqual([
      'mobile',
      'mobile',
      'tablet',
      'tablet',
      'laptop',
      'laptop',
      'desktop',
      'desktop',
    ])
    for (const bad of [0, -1, NaN, Infinity, '800', null, undefined])
      expect(screenClass(bad)).toBeNull()
  })

  test('continents', () => {
    expect([
      continentOf('DE'),
      continentOf('US'),
      continentOf('BR'),
      continentOf('JP'),
      continentOf('ZA'),
      continentOf('AU'),
      continentOf('AQ'),
    ]).toEqual([
      'Europe',
      'North America',
      'South America',
      'Asia',
      'Africa',
      'Oceania',
      'Antarctica',
    ])
    expect(continentOf('ZZ')).toBeNull()
    expect(continentOf(null)).toBeNull()
  })

  test('timezones come from Cloudflare and Vercel headers and must look like an IANA name', () => {
    expect(geoFromHeaders(new Headers({ 'cf-timezone': 'Europe/Berlin' })).timezone).toBe(
      'Europe/Berlin',
    )
    expect(
      geoFromHeaders(new Headers({ 'x-vercel-ip-timezone': 'America/Argentina/Buenos_Aires' }))
        .timezone,
    ).toBe('America/Argentina/Buenos_Aires')
    for (const bad of ['<script>', 'x'.repeat(60), 'a b', '../etc/passwd', ''])
      expect(timezone(bad)).toBeNull()
  })
})

describe('csv export', () => {
  test('csv exposes the new columns', async () => {
    const { tm, hit, at } = setup()
    await hit('1.1.1.1', IPHONE, '/', T0, { screenWidth: 390, timezone: 'Europe/Paris' })
    at(T0 + MIN)
    const csv = await (
      await tm.handle(
        new Request('http://x/api/export.csv', { headers: { authorization: 'Bearer k' } }),
      )
    ).text()
    expect(csv.split('\n')[0]).toContain('browser_version,os,os_version,device,screen')
    expect(csv).toContain('iOS,17,mobile,mobile') // os, os_version, device, screen
    expect(csv).toContain('Europe/Paris')
  })
})

describe('vercel adapter', () => {
  test('exposes GET, POST and OPTIONS over one handler, mounted under a base path', async () => {
    const tm = createTallymark({ apiKey: 'k', basePath: '/api/analytics' })
    const h = vercel(tm)
    expect((await h.GET(new Request('http://x/api/analytics/health'))).status).toBe(200)
    const post = await h.POST(
      new Request('http://x/api/analytics/collect', {
        method: 'POST',
        body: '{"url":"https://example.com/"}',
        headers: { 'user-agent': WIN },
      }),
    )
    expect(post.status).toBe(202)
    expect(
      (await h.OPTIONS(new Request('http://x/api/analytics/collect', { method: 'OPTIONS' })))
        .status,
    ).toBe(204)
  })

  test('waitUntil defers forwarding until after the response', async () => {
    let delivered = false
    const background: Promise<unknown>[] = []
    const tm = createTallymark({
      basePath: '/a',
      forward: async () => {
        await Bun.sleep(20)
        delivered = true
      },
    })
    const { POST } = vercel(tm, { waitUntil: (p) => void background.push(p) })
    await POST(
      new Request('http://x/a/collect', {
        method: 'POST',
        body: '{"url":"https://example.com/"}',
        headers: { 'user-agent': WIN },
      }),
    )
    expect(delivered).toBe(false)
    await Promise.all(background)
    expect(delivered).toBe(true)
  })

  test('reads the visitor location from Vercel headers', async () => {
    const tm = createTallymark({ apiKey: 'k', basePath: '/a' })
    const { POST } = vercel(tm)
    await POST(
      new Request('http://x/a/collect', {
        method: 'POST',
        body: '{"url":"https://example.com/"}',
        headers: {
          'user-agent': WIN,
          'x-real-ip': '8.8.8.8',
          'x-vercel-ip-country': 'FR',
          'x-vercel-ip-city': 'Saint-%C3%89tienne',
          'x-vercel-ip-timezone': 'Europe/Paris',
        },
      }),
    )
    expect((await tm.events('24h'))[0]).toMatchObject({
      country: 'FR',
      city: 'Saint-Étienne',
      timezone: 'Europe/Paris',
    })
  })

  test('cron: refuses without the secret, prunes with it', async () => {
    const t0 = Date.now()
    let t = t0
    const tm = createTallymark({ retentionDays: 30, now: () => t })
    await tm.track({ url: 'https://example.com/', userAgent: WIN, ts: t0 })
    t = t0 + 31 * 86_400_000
    const cron = vercelCron(tm, { secret: 'cron-secret' })
    const call = (auth?: string) =>
      cron(new Request('http://x/cron', { headers: auth ? { authorization: auth } : {} }))
    expect((await call()).status).toBe(401)
    expect((await call('Bearer wrong')).status).toBe(401)
    const ok = await call('Bearer cron-secret')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, pruned: 1 })
    expect(
      (
        await vercelCron(tm, { secret: undefined })(
          new Request('http://x/cron', { headers: { authorization: 'Bearer ' } }),
        )
      ).status,
    ).toBe(401) // unset secret never matches
  })
})

describe('trackRequest: nothing to extract by hand', () => {
  const visitorRequest = (
    extra: Record<string, string> = {},
    url = 'https://shop.example/api/subscribe?utm_source=newsletter&token=secret',
  ) =>
    new Request(url, {
      method: 'POST',
      headers: {
        'user-agent': IPHONE,
        'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        'accept-language': 'fr-FR,fr;q=0.9',
        referer: 'https://www.google.com/search?q=x',
        'cf-ipcountry': 'FR',
        'cf-timezone': 'Europe/Paris',
        ...extra,
      },
    })

  test('reads IP, browser, language, location, referrer and campaign from the request', async () => {
    const { tm } = setup()
    const r = await tm.trackRequest(visitorRequest(), {
      name: 'Subscribe',
      props: { plan: 'free' },
      value: 5,
    })
    expect(r.ok).toBe(true)
    const [e] = await tm.events('24h')
    expect(e).toMatchObject({
      type: 'event',
      name: 'Subscribe',
      value: 5,
      props: { plan: 'free' },
      path: '/api/subscribe',
      hostname: 'shop.example',
      browser: 'Safari',
      os: 'iOS',
      device: 'mobile',
      language: 'fr-FR',
      country: 'FR',
      timezone: 'Europe/Paris',
      referrerHost: 'google.com',
      utm: { source: 'newsletter' },
    })
    expect(JSON.stringify(e)).not.toContain('203.0.113.9') // the IP only feeds the hash
    expect(JSON.stringify(e)).not.toContain('token=secret') // non-campaign query params are dropped
  })

  test('the same person is one visitor across the browser script and server-side events', async () => {
    const { tm } = setup()
    const headers = { 'user-agent': WIN, 'x-forwarded-for': '198.51.100.7' }
    await tm.handle(
      new Request('http://x/collect', {
        method: 'POST',
        body: '{"url":"https://shop.example/"}',
        headers,
      }),
    )
    await tm.trackRequest(
      new Request('https://shop.example/api/pay', { method: 'POST', headers }),
      { name: 'Purchase', value: 20 },
    )
    const visitors = new Set((await tm.events('24h')).map((e) => e.visitor))
    expect(visitors.size).toBe(1)
  })

  test('omitting the name records a pageview; url can be overridden', async () => {
    const { tm } = setup()
    await tm.trackRequest(visitorRequest({}, 'https://shop.example/a'))
    await tm.trackRequest(visitorRequest({}, 'https://shop.example/a'), {
      url: 'https://shop.example/virtual-page',
    })
    const events = await tm.events('24h')
    expect(events.map((e) => [e.type, e.path])).toEqual([
      ['pageview', '/a'],
      ['pageview', '/virtual-page'],
    ])
  })

  test('honours Do-Not-Track and Global Privacy Control, and says so', async () => {
    const { tm } = setup()
    expect(await tm.trackRequest(visitorRequest({ dnt: '1' }), { name: 'x' })).toEqual({
      ok: false,
      reason: 'dnt',
    })
    expect(await tm.trackRequest(visitorRequest({ 'sec-gpc': '1' }), { name: 'x' })).toEqual({
      ok: false,
      reason: 'dnt',
    })
    expect((await tm.events('24h')).length).toBe(0)
    const off = createTallymark({ respectDnt: false })
    expect((await off.trackRequest(visitorRequest({ dnt: '1' }), { name: 'x' })).ok).toBe(true)
  })

  test('skips bots and returns why, like track()', async () => {
    const { tm } = setup()
    expect(
      await tm.trackRequest(visitorRequest({ 'user-agent': 'Googlebot/2.1' }), { name: 'x' }),
    ).toEqual({ ok: false, reason: 'bot' })
  })

  test('with trustProxy false, forwarded headers are ignored and the socket address is used', async () => {
    const { tm } = setup({ trustProxy: false })
    const req = () =>
      visitorRequest({ 'x-forwarded-for': String(Math.random()), 'cf-ipcountry': 'FR' })
    await tm.trackRequest(req(), { name: 'a' }, { ip: '192.0.2.1' })
    await tm.trackRequest(req(), { name: 'a' }, { ip: '192.0.2.1' })
    const events = await tm.events('24h')
    expect(new Set(events.map((e) => e.visitor)).size).toBe(1) // spoofed XFF did not split the visitor
    expect(events[0]!.country).toBeNull() // spoofable geo header ignored
  })
})
