// bun examples/frameworks/hono.ts
//
// Hono runs on Bun, Deno, Cloudflare Workers and Node. Tallymark is a plain Fetch handler
// (Request in, Response out), so it mounts without an adapter.
import { Hono } from 'hono'
import { createTallymark } from 'tallymark'

const analytics = createTallymark({
  secret: 'change-me', //     salts the anonymous visitor hash
  apiKey: 'dev-key', //       protects the read API; without it the read API is off
  basePath: '/analytics', //  must match the mount path below
})

const app = new Hono()

// The whole Tallymark API: the browser script, the hit endpoint and the reports.
app.all('/analytics/*', (c) => analytics.handle(c.req.raw))

// A route of your own that records an event the browser can't see.
// trackRequest reads the visitor's IP, browser, language, location and referrer from the request,
// so you only say what happened. Omit `name` and it records a pageview instead.
app.post('/checkout', async (c) => {
  const result = await analytics.trackRequest(c.req.raw, {
    name: 'Purchase', //  what happened
    value: 49, //         added up in the reports as revenue
    // props: { sku: 'A1' },  // optional facts to break the event down by
  })
  // result is { ok: true, event } or { ok: false, reason } ('bot', 'dnt', ...). It never throws.
  return c.json({ ok: true, tracked: result.ok })
})

// The one line a page needs for pageviews, sources, devices, time on page and scroll depth.
app.get('/', (c) =>
  c.html('<script defer src="/analytics/script.js" data-localhost="true"></script><h1>Hello</h1>'),
)

// Bun reads `port` and `fetch` from the default export.
export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch }
