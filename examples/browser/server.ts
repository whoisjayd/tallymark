// bun examples/website/server.ts  →  open http://localhost:3000
//
// The complete loop in one file: a web page loads the tracker, the tracker sends
// hits to Tallymark, and you read the numbers back from the API.
//
// What happens when you open the page:
//   1. index.html loads /analytics/script.js (the browser tracker, served by Tallymark itself)
//   2. the script sends a pageview to /analytics/collect, then time on page and scroll when you leave
//   3. Tallymark works out browser, OS, device, language and (behind a CDN) location from that request
//   4. you read it back: curl -H 'Authorization: Bearer dev-key' .../analytics/api/summary?range=1h
import { createTallymark } from 'tallymark'

const tm = createTallymark({
  secret: 'dev-secret',
  apiKey: 'dev-key',
  basePath: '/analytics', // Tallymark lives under /analytics on this server
})

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req, srv) {
    const { pathname } = new URL(req.url)
    if (pathname.startsWith('/analytics')) {
      return tm.handle(req, { ip: srv.requestIP(req)?.address })
    }
    if (pathname === '/') return new Response(Bun.file(`${import.meta.dir}/index.html`))
    return new Response('not found', { status: 404 })
  },
})

console.log(`site: ${server.url}`)
console.log(
  `stats: curl -H 'Authorization: Bearer dev-key' '${server.url}analytics/api/summary?range=1h'`,
)
