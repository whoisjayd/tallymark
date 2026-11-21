// bun examples/library/reports.ts
//
// Every kind of question Tallymark answers, on a small made-up day of traffic.
//
// IMPORTANT: the traffic below is typed in by hand ONLY so this file can run on its own.
// In a real app you write none of it. The browser script (<script src=".../script.js">) or the
// <Analytics /> component records, automatically and with no code:
//   pageviews, referrer, ?utm_* campaign, browser, OS, device, language, screen size,
//   country/region/city/timezone (from your host's headers), time on page, and scroll depth.
// The only thing you add yourself is a custom event, e.g. data-tally="Signup" on a button.
// Everything after the "Ask" comments is what you would run to read the numbers back.
import { createTallymark } from 'tallymark'

const now = Date.now()
const tm = createTallymark({ secret: 'demo', now: () => now })

const WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1'

/** One visitor's hits. Geo and device are the same for every hit, as in real traffic.
 *  secondsAgo: when it happened. extra: the page's referrer, or an engagement beacon (time on page). */
async function visit(
  who: Record<string, unknown>,
  hits: Array<[secondsAgo: number, path: string, extra?: Record<string, unknown>]>,
) {
  for (const [secondsAgo, path, extra] of hits) {
    await tm.track({
      url: `https://shop.example${path}`,
      ts: now - secondsAgo * 1000,
      ...who,
      ...extra,
    })
  }
}

// Alice: found us on Google, read the home page 40 s, then pricing, then signed up and paid.
// (The `engagement` rows are what the browser script reports on its own when a visitor leaves a page.)
await visit(
  {
    ip: '10.0.0.1',
    userAgent: WIN,
    country: 'DE',
    city: 'Berlin',
    timezone: 'Europe/Berlin',
    language: 'de-DE',
    screenWidth: 1920,
  },
  [
    [300, '/', { referrer: 'https://www.google.com/' }],
    [260, '/', { name: 'engagement', duration: 40_000, scroll: 70 }], // time on page, reported by the browser script
    [259, '/pricing'],
    [230, '/pricing', { name: 'engagement', duration: 25_000, scroll: 100 }],
    [229, '/signup'],
    [200, '/signup', { name: 'Signup', props: { plan: 'pro' }, value: 49 }],
  ],
)
// Bob: came from a newsletter on his phone, looked at pricing, left.
await visit(
  {
    ip: '10.0.0.2',
    userAgent: IPHONE,
    country: 'US',
    city: 'Austin',
    language: 'en-US',
    screenWidth: 390,
  },
  [
    [200, '/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=spring'],
    [170, '/pricing', { name: 'engagement', duration: 12_000, scroll: 35 }],
  ],
)
// Carol: arrived directly, bounced.
await visit(
  {
    ip: '10.0.0.3',
    userAgent: WIN,
    country: 'DE',
    city: 'Munich',
    language: 'de-DE',
    screenWidth: 1366,
  },
  [[100, '/']],
)

const show = (title: string, value: unknown) =>
  console.log(`\n── ${title}\n`, JSON.stringify(value, null, 1).replace(/\n\s*/g, ' '))

// Ask ───────────────────────────────────────────────────────────────────────
// Totals ---------------------------------------------------------------------
show('summary', await tm.summary('24h')) // pageviews, visitors, sessions, bounce rate, time on site, revenue
show('vs. the previous period', (await tm.compare('24h')).delta.pageviews)

// Over time: hour, day, week or month ------------------------------------------
show(
  'timeseries (hourly)',
  (await tm.timeseries('24h')).filter((p) => p.pageviews),
)

// Breakdowns: any dimension, optionally filtered -------------------------------
show('top pages, with time on page and scroll depth', await tm.top('path', '24h'))
show('where visitors come from', await tm.top('channel', '24h'))
show('sources', await tm.top('source', '24h'))
show('countries', await tm.top('country', '24h'))
show('continents', await tm.top('continent', '24h'))
show('devices', await tm.top('device', '24h'))
show('screen sizes', await tm.top('screen', '24h'))
show('browsers and versions', await tm.top('browser_version', '24h'))
show('operating systems', await tm.top('os', '24h'))
show('languages', await tm.top('language', '24h'))
show('entry pages', await tm.top('entry_page', '24h'))
show('exit pages', await tm.top('exit_page', '24h'))
show('only mobile visitors', await tm.top('path', '24h', { device: 'mobile' }))

// Events: counts, revenue, and any custom property ------------------------------
show('events, with revenue', await tm.top('event', '24h'))
show(
  "revenue by source (events inherit the visitor's first source)",
  await tm.top('event', '24h', { channel: 'Organic Search' }),
)
show('events broken down by a property', await tm.top('event', '24h', { 'prop:plan': 'pro' }))

// Paths travelled ----------------------------------------------------------------
show('funnel', await tm.funnel([{ path: '/' }, { path: '/pricing' }, { event: 'Signup' }], '24h'))
show('common journeys', await tm.journeys('24h', {}, { depth: 3 }))
const [alice] = await tm.sessions('24h', { screen: 'desktop' }) // Alice's 1920px-wide window
show('one session, step by step', {
  source: alice?.source,
  seconds: alice?.seconds,
  revenue: alice?.revenue,
  steps: alice?.steps,
})

// Live ------------------------------------------------------------------------
show('realtime', await tm.realtime())
