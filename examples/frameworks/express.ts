// bun examples/frameworks/express.ts   (or run with node + tsx)
//
// Tallymark inside an existing Express app. It does three jobs here:
//   1. serves the browser script and receives its hits         (app.use('/analytics', ...))
//   2. lets your own routes record events the browser can't see (analytics.trackRequest)
//   3. lets you read the numbers in-process                     (analytics.summary)
import express from 'express'
import { createTallymark } from 'tallymark'
import { nodeConn, nodeHandler, nodeRequest } from 'tallymark/node'

const analytics = createTallymark({
  secret: 'change-me', //        salts the anonymous visitor hash: use a long random value
  apiKey: 'dev-key', //          protects the read API (/analytics/api/*). Without it the read API is off.
  basePath: '/analytics', //     must match where it is mounted below

  // Whether to believe X-Forwarded-For / CF-Connecting-IP for the visitor's IP.
  // true  → you are behind nginx, Caddy, a load balancer or Cloudflare that sets them.
  // false → Express is exposed directly; the socket address is used instead (safer, the default for the CLI).
  trustProxy: true,
})

const app = express()

// 1. The whole Tallymark API under /analytics:
//      POST /analytics/collect   hits from the browser script
//      GET  /analytics/script.js the browser script itself
//      GET  /analytics/api/*     reports (needs the API key)
app.use('/analytics', nodeHandler(analytics, { trustProxy: true }))

// 2. A custom event from your own route, for something the browser can't see (here: a signup API call).
//    trackRequest reads the visitor's IP, browser, language, location and referrer FROM THE REQUEST,
//    so you only say what happened:
//      name   what happened                  props  facts to break it down by later
//      value  a number to add up (revenue)
//    nodeRequest(req) turns Express's request into a standard Request without touching the body
//    stream, so it is safe after express.json().
app.post('/api/subscribe', express.json(), async (req, res) => {
  await analytics.trackRequest(
    nodeRequest(req),
    { name: 'Subscribe', props: { plan: String(req.body?.plan ?? 'free') }, value: 5 },
    nodeConn(req, { trustProxy: true }),
  )
  res.json({ ok: true })
})

// 3. Read numbers directly, with no HTTP round trip. Protect this route yourself: it is YOUR route.
app.get('/admin/summary', async (_req, res) => res.json(await analytics.summary('7d')))

// The only line a page needs. Pageviews, sources, devices, time on page and scroll depth follow.
app.get('/', (_req, res) =>
  res.send(
    '<script defer src="/analytics/script.js" data-localhost="true"></script><h1>Hello</h1>',
  ),
)

const port = Number(process.env.PORT ?? 3000)
app.listen(port, () => console.log(`http://localhost:${port}`))
