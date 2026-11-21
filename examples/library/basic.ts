// bun examples/library/basic.ts
//
// Tallymark as a plain library: no server, no database, no browser.
// This is the smallest way to see what it does: record hits from your own code, then ask questions.
//
// In a real app you rarely call track() for pageviews yourself. The browser script (or the
// <Analytics /> component) sends those automatically. track() / trackRequest() are for events
// that happen on your server, and for apps that have no browser at all (a CLI, a game server).
import { createTallymark, memoryStore, mirrorStore, webhookSink } from 'tallymark'

const tm = createTallymark({
  // Salts the anonymous visitor hash. Use a long random value and keep it private.
  // Changing it makes every existing visitor look new, which is a quick way to "forget" everyone.
  secret: 'change-me-to-a-long-random-string',

  // Where events are kept. The default is in-memory (gone on restart): perfect for a demo.
  // Swap in pgStore(...), d1Store(...), bunSqliteStore(...), upstashRestStore(...) for real use.
  store: memoryStore(),

  // Ignore hits from these IP addresses: your own office, uptime checks.
  excludeIps: ['203.0.113.7'],

  // Failures never crash a request, so they are reported here instead. Send them to your logger.
  onError: (error, { where }) => console.error(where, error),
})

const chrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'

// ── 1. Record hits ──────────────────────────────────────────────────────────────────────────
// Each hit needs a url. ip and userAgent identify the visitor (they are hashed with a daily salt
// and never stored). Everything else is optional context you happen to know.
const alice = { ip: '198.51.100.1', userAgent: chrome, country: 'DE', language: 'de-DE' }
const bob = { ip: '198.51.100.2', userAgent: chrome, country: 'US', language: 'en-US' }

// A pageview. The referrer says where the visitor came from; ?utm_* in the url is the campaign.
await tm.track({
  url: 'https://shop.example/',
  referrer: 'https://news.ycombinator.com/',
  ...alice,
})
await tm.track({ url: 'https://shop.example/pricing?utm_source=newsletter', ...alice })

// A custom event: a `name`, optional `props` to break it down by later, optional `value` to sum.
await tm.track({
  name: 'Signup',
  url: 'https://shop.example/signup',
  props: { plan: 'pro' },
  value: 49,
  ...alice,
})

await tm.track({ url: 'https://shop.example/', ...bob })

// ── 2. Hits can be skipped, and you are told why ───────────────────────────────────────────
// track() never throws. It returns { ok: true, event } or { ok: false, reason }.
// Reasons: 'bot' 'dnt' 'excluded' 'spam' 'host' 'invalid' 'storage' ...
const bot = await tm.track({
  url: 'https://shop.example/',
  userAgent: 'Googlebot/2.1',
  ip: '66.249.66.1',
})
console.log('bot ->', bot) // { ok: false, reason: 'bot' }

// ── 3. Ask questions ───────────────────────────────────────────────────────────────────────
// The first argument is a time range: '1h' '24h' '7d' '30d' '90d' '365d', or { from, to } in ms.
console.log('summary', await tm.summary('24h')) //           visitors, pageviews, bounce rate, revenue ...
console.log('top pages', await tm.top('path', '24h')) //      any dimension: path, country, channel, device ...
console.log('top countries', await tm.top('country', '24h'))
console.log('revenue by event', await tm.top('event', '24h')) // counts events and adds up their `value`
console.log('only Germany', await tm.summary('24h', { country: 'DE' })) // the third argument filters
console.log('vs. previous period', (await tm.compare('24h')).delta.pageviews)

// ── 4. A funnel ────────────────────────────────────────────────────────────────────────────
// Of the visitors who saw the home page, how many reached pricing, then signed up?
// A step is a page { path } (a trailing * matches a prefix) or an event { event }.
console.log(
  'funnel',
  await tm.funnel([{ path: '/' }, { path: '/pricing' }, { event: 'Signup' }], '24h'),
)

// ── 5. Backup and restore ──────────────────────────────────────────────────────────────────
// One JSON event per line. Works between any two stores, so it doubles as a migration tool.
const backup = await tm.export('24h')
const restored = createTallymark({ secret: 'x' })
console.log('restored', await restored.import(backup)) // { imported: 4, skipped: 0 }

// ── 6. Optional: backups and third parties ─────────────────────────────────────────────────
// mirrorStore: every event is written to the primary and copied to the backups.
// forward: every event is also POSTed (signed) to a URL you control: Zapier, n8n, your own service.
const withBackups = createTallymark({
  store: mirrorStore(memoryStore(), memoryStore()),
  forward: webhookSink({ url: 'https://hooks.example.com/tallymark', secret: 'whsec_123' }),
})
void withBackups
