# DEPLOYMENT

Pick the platform you already use. Every option serves the same routes. Examples that run are in [../examples/frameworks](../examples/frameworks).

Before anything else, in every deployment:

- Set `secret` and `apiKey` to long random values (`openssl rand -hex 32`) and keep them in your platform's secret store.
- Decide `trustProxy`. It is `true` for the library by default and `false` for the CLI. Set it to `true` only when Cloudflare, Vercel or a proxy you control sets the client-IP headers. Otherwise visitors can forge them.
- Put your site in `allowedHosts` (and turn on `strictOrigin`) so other sites cannot write to your numbers.
- Connect `onError` to a logger.
- Set `retentionDays` and arrange for `prune()` to run.

| Platform | Store | Notes |
|---|---|---|
| [Cloudflare Workers](#cloudflare-workers) | D1 | Location is built in |
| [Vercel and Next.js](#vercel-and-nextjs) | Postgres, Upstash, Turso | Location is built in |
| [Bun, Docker, any server](#bun-docker-and-any-server) | SQLite, Postgres, Upstash | |
| [Node and Express](#node-and-express) | any | |
| [Other Fetch frameworks](#other-fetch-frameworks) | any | |

## Cloudflare Workers

```ts
import { cloudflare } from 'tallymark/cloudflare'
import { d1Store } from 'tallymark/stores'

export default cloudflare<Env>((env) => ({
  store: d1Store(env.DB),
  secret: env.SECRET,
  apiKey: env.API_KEY,
  retentionDays: 395,
}))
```

```bash
wrangler d1 create stats          # then bind it as DB in wrangler.toml
wrangler secret put SECRET && wrangler secret put API_KEY
wrangler deploy
```

Add `[triggers] crons = ["0 3 * * *"]` and the adapter prunes old events daily. The table is created on first use. Country, region, city and timezone come from Cloudflare's `request.cf`, so there is nothing to configure. Work after the response (forwarding) runs through `ctx.waitUntil`. The full file is [examples/frameworks/cloudflare.ts](../examples/frameworks/cloudflare.ts).

## Vercel and Next.js

Pick a store that suits serverless: Postgres through Neon (`pgStore(neon(url))`), Upstash Redis (`upstashRestStore`), or Turso (`libsqlStore`). Vercel provides the visitor's IP, country, region, city and timezone as headers, and Tallymark reads them.

**Next.js (App Router):**

```ts
// lib/analytics.ts
export const analytics = createTallymark({
  store: pgStore(new Pool({ connectionString: process.env.DATABASE_URL })),
  secret: process.env.ANALYTICS_SECRET,
  apiKey: process.env.ANALYTICS_API_KEY,
  basePath: '/api/analytics',
})

// app/api/analytics/[...route]/route.ts
import { waitUntil } from '@vercel/functions'
export const { GET, POST, OPTIONS } = vercel(analytics, { waitUntil })

// app/api/analytics-cron/route.ts
export const GET = vercelCron(analytics, { secret: process.env.CRON_SECRET })

// app/layout.tsx, inside <body>
<Analytics api="/api/analytics" outbound downloads />
```

```json
{ "crons": [{ "path": "/api/analytics-cron", "schedule": "0 3 * * *" }] }
```

`waitUntil` is optional; with it, forwarding continues after the response is sent. Mirror copies (`mirrorStore`) are written before the response, so a slow mirror slows the hit; a failing mirror is reported to `onError` and never fails it. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, so set `CRON_SECRET` in the project settings; `vercelCron` refuses every call without it.

**Without a framework**, put the same `vercel(analytics)` in `/api/analytics.ts` and add a rewrite so sub-paths reach it ([example](../examples/frameworks/vercel)).

## Bun, Docker and any server

```bash
# A SQLite file (the default)
TALLYMARK_SECRET=… TALLYMARK_API_KEY=… bunx tallymark

# PostgreSQL
TALLYMARK_DB=postgres://user:pass@host/db bunx tallymark

# Upstash Redis
UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… bunx tallymark
```

```bash
docker build -t tallymark .
docker run -p 3000:3000 -v stats:/data \
  -e TALLYMARK_SECRET=… -e TALLYMARK_API_KEY=… tallymark
```

The image runs as an unprivileged user, keeps its data in the `/data` volume, and has a health check on `/health`. Every variable is listed in [USAGE.md](./USAGE.md#the-command-line).

### Behind a reverse proxy

Set `TALLYMARK_TRUST_PROXY=true` **only** when a proxy you control sits in front, and make sure it overwrites client-supplied forwarding headers. Otherwise a visitor can invent their IP, which forges visitor ids and dodges the rate limit. Terminate TLS at the proxy.

```
# Caddy: X-Forwarded-For is replaced with the real address by default
stats.example.com {
    request_header -CF-Connecting-IP
    request_header -X-Real-IP
    reverse_proxy 127.0.0.1:3000
}
```

```
# nginx
location / {
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://127.0.0.1:3000;
}
```

Without `TALLYMARK_TRUST_PROXY`, the socket address is used, which is right when the server is exposed directly. The library default is `trustProxy: true`, so set `trustProxy: false` on a server that clients reach directly: otherwise a client can forge `X-Forwarded-For` to dodge the rate limit and appear as new visitors.

## Node and Express

```ts
import { nodeHandler, nodeRequest, nodeConn } from 'tallymark/node'

app.use('/analytics', nodeHandler(analytics, { trustProxy: true })) // trustProxy only behind a proxy you control

// In your own routes:
await analytics.trackRequest(nodeRequest(req), { name: 'Subscribe' }, nodeConn(req, { trustProxy: true }))
```

Set `basePath: '/analytics'` to match the mount path. The adapter is structural and imports nothing from Node.

## Other Fetch frameworks

`analytics.handle` is `(Request) => Promise<Response>`, so it mounts directly. Set `basePath` to match where you mount it.

```ts
app.all('/analytics/*', (c) => analytics.handle(c.req.raw))        // Hono
export { handler as GET, handler as POST, handler as OPTIONS }     // SvelteKit +server.ts
export const ALL = ({ request }) => analytics.handle(request)      // Astro
Deno.serve((req, info) => analytics.handle(req, { ip: info.remoteAddr.hostname }))
```

## Retention and backups

Set `retentionDays`, and run `prune()` on a schedule: the CLI does it at boot and daily, Cloudflare uses the cron trigger, Vercel uses `vercelCron`. For anything else, call it from your own scheduler.

For a live backup, wrap your store: `mirrorStore(primary, [backup])`. For point-in-time backups and moves between stores:

```bash
curl -H "Authorization: Bearer $KEY" "$HOST/api/export.ndjson?range=365d" > backup.ndjson
curl -X POST -H "Authorization: Bearer $KEY" --data-binary @backup.ndjson "$OTHER_HOST/api/import"
```
