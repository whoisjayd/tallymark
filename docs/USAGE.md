# USAGE

The complete reference. For the ideas behind it, read [HOW_IT_WORKS.md](./HOW_IT_WORKS.md). For deployment, read [DEPLOYMENT.md](./DEPLOYMENT.md).

## Contents

- [Entry points](#entry-points)
- [Creating an instance](#creating-an-instance)
- [Recording events](#recording-events)
- [Asking questions](#asking-questions)
- [The browser script](#the-browser-script)
- [The HTTP API](#the-http-api)
- [The command line](#the-command-line)
- [Backups, forwarding and hooks](#backups-forwarding-and-hooks)

## Entry points

| Import | What it gives you |
|---|---|
| `tallymark` | `createTallymark`, `memoryStore`, `mirrorStore`, `webhookSink`, `verifyWebhookSignature`, and every type |
| `tallymark/stores` | `bunSqliteStore`, `pgStore`, `postgresJsStore`, `d1Store`, `libsqlStore`, `upstashRestStore`, `upstashStore`, `redisStore`, `sqlStore`, plus `memoryStore` and `mirrorStore` |
| `tallymark/react` | `<Analytics />` and `track()` |
| `tallymark/node` | `nodeHandler`, `nodeRequest`, `nodeConn` for Express, Fastify and Node `http` |
| `tallymark/cloudflare` | `cloudflare()`, a Worker with a scheduled retention sweep |
| `tallymark/vercel` | `vercel()` route handlers and `vercelCron()` |

The package is ESM only and has no runtime dependencies. The core uses only web-standard APIs, so it runs on Bun, Node, Deno, Cloudflare Workers and Vercel.

## Creating an instance

```ts
import { createTallymark } from 'tallymark'

const tm = createTallymark({ secret: process.env.SECRET })
```

Every option is optional.

| Option | Default | Meaning |
|---|---|---|
| `secret` | random per process | Salts the visitor hash. **Set it in production**; with the default, visitors reset on every restart. |
| `store` | `memoryStore()` | Where events are kept. See [Storage](../README.md#storage). |
| `apiKey` | none | Bearer token for the read API. Without it, `/api/*` answers `401` to everyone. |
| `allowedOrigins` | `'*'` | Origins allowed to post hits from a browser (CORS). |
| `allowedHosts` | any | Only record hits for these hostnames. |
| `strictOrigin` | `false` | Require the browser's `Origin` or `Referer` host to be in `allowedHosts`. |
| `excludeIps` | none | Ignore hits from these IP addresses. |
| `blockedReferrers` | none | Extra referrer hosts to treat as spam, on top of a built-in list. |
| `respectDnt` | `true` | Ignore hits that send `DNT: 1` or `Sec-GPC: 1`. |
| `rateLimit` | 120 per minute per IP | `{ max, windowMs }`, or `false`. Per process, best effort. |
| `trustProxy` | `true` | Read the visitor's IP and location from proxy headers (Cloudflare, Vercel, `X-Forwarded-For`). Set `false` unless a proxy you control sets them. |
| `basePath` | `''` | The prefix the HTTP handler is mounted under, such as `/api/analytics`. |
| `retentionDays` | keep forever | Age after which `prune()` deletes events. |
| `sessionMinutes` | `30` | Inactivity that ends a session. |
| `forward` | none | Called with every recorded event, to send it elsewhere. See [webhookSink](#backups-forwarding-and-hooks). |
| `onError` | none | Called for failures that are swallowed (storage errors, exceptions). **Connect it to your logger.** |

## Recording events

Pageviews come from the [browser script](#the-browser-script). Use these for events from your own code.

### `trackRequest(request, event?, info?)`

Use this when you are handling a visitor's request. It reads their IP, browser, language, location and referrer from it.

```ts
await tm.trackRequest(request, {
  name: 'Signup',          // omit for a pageview
  props: { plan: 'pro' },  // flat: strings, numbers, booleans; at most 20, short keys and values
  value: 49,               // a number to add up, such as revenue
  url: 'https://…',        // optional: defaults to the request URL
})
```

`info` carries what only your platform knows: `{ ip, geo, waitUntil }`. For Node and Express, build the `Request` with `nodeRequest(req)` and the info with `nodeConn(req)`.

### `track(input, info?)`

Use this when there is no visitor request (a webhook, a job). Everything but `url` is optional.

```ts
await tm.track({
  url: 'https://shop.example/checkout/success',
  name: 'Purchase', props: { sku: 'A1' }, value: 49,
  ip, userAgent,            // identify the visitor; hashed, never stored
  referrer, language, country, region, city, timezone,
  screenWidth: 1440,        // bucketed into mobile / tablet / laptop / desktop
  ts: Date.now(),
})
```

Both return `{ ok: true, event }` or `{ ok: false, reason }` and **never throw**. Reasons: `bot`, `dnt`, `excluded`, `spam`, `host`, `prefetch`, `invalid`, `rate_limited`, `origin`, `too_large`, `storage`.

Event names are trimmed to 80 characters. `pageview` and `engagement` are reserved. `engagement` needs a `duration` in milliseconds (capped at four hours) and may carry a `scroll` from 0 to 100.

## Asking questions

Every method takes a **range** first: `'1h'`, `'24h'`, `'7d'`, `'30d'`, `'90d'`, `'365d'`, or `{ from, to }` in epoch milliseconds, ending now by default. Most take **filters** second: `{ country: 'DE', device: 'mobile', 'prop:plan': 'pro' }`.

| Method | Returns |
|---|---|
| `summary(range, filters?)` | `pageviews`, `visitors`, `sessions`, `events`, `revenue`, `bounceRate`, `avgSessionSeconds`, `avgTimeOnPageSeconds`, `viewsPerSession` |
| `compare(range, filters?)` | `{ current, previous, delta }`, comparing with the equally long period before; `change` is `null` when the previous value was 0 |
| `timeseries(range, filters?, interval?)` | Buckets with `pageviews`, `visitors`, `events`. `interval` is `hour`, `day`, `week` (Monday start) or `month`; the default widens with the range. |
| `top(dimension, range, filters?, limit?)` | Rows of `{ key, visitors, count, value?, seconds?, scroll? }`, most common first. `limit` is 1 to 100. |
| `funnel(steps, range, filters?)` | One row per step: `visitors`, `rate` (of step 1), `dropoff` (from the previous step) |
| `sessions(range, filters?, limit?)` | Recent sessions, newest first, each with its ordered `steps` |
| `journeys(range, filters?, { depth, limit }?)` | The most common first `depth` pages of a session (default 3), with `sessions` and `share` |
| `realtime(minutes?)` | Visitors, pageviews and top pages in the last 5 minutes |
| `events(range, filters?, limit?)` | The raw events, oldest first |
| `export(range?, filters?)` / `import(ndjson)` | Backup and restore, one JSON event per line |
| `prune()` | Deletes events older than `retentionDays`; returns how many |

### Dimensions

`top()` groups by a dimension, and every dimension is also a filter.

| Group | Dimensions |
|---|---|
| Pages | `path`, `entry_page`, `exit_page`, `hostname` |
| Sources | `referrer`, `source`, `channel`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` |
| Location | `country`, `continent`, `region`, `city`, `timezone`, `language` |
| Device | `browser`, `browser_version`, `os`, `os_version`, `device`, `screen` |
| Events | `event`, and `prop:<name>` for any custom property |
| Time (UTC) | `weekday` (`Mon`…`Sun`), `hour` (`00`…`23`) |

`entry_page` and `exit_page` work with `top()` only, not as filters.

`top('event')` counts events and adds up their `value`. `top('prop:plan')` does the same for events that carry a `plan` property, so `top('prop:plan', '30d', { event: 'Signup' })` is signups by plan, with revenue. Every other dimension counts pageviews, and `path` also reports average `seconds` on the page and average `scroll` depth.

Custom events and engagement beacons inherit the source of the visitor's session, so `top('event', '30d', { channel: 'Social' })` is the events that came from social traffic.

Funnel steps are `{ path: '/pricing' }` (a trailing `*` matches a prefix) or `{ event: 'Signup' }`, in order.

## The browser script

Serve it from your Tallymark instance and add one tag:

```html
<script defer src="https://stats.example.com/script.js"></script>
```

It records a pageview on load and on every history navigation, plus time on page and scroll depth. It sets no cookies and writes nothing to storage. About 4 KB (1.7 KB gzipped).

Settings are `data-` attributes on the tag:

| Attribute | Default | Effect |
|---|---|---|
| `data-api` | where the script was served from | The base URL hits are sent to |
| `data-auto` | `true` | `"false"` turns off automatic pageviews (you call `tallymark.pageview()`) |
| `data-outbound` | off | `"true"` records clicks on links to other sites as `outbound` |
| `data-downloads` | off | `"true"` records clicks on files as `download` |
| `data-engagement` | on | `"false"` turns off time on page and scroll depth |
| `data-localhost` | off | `"true"` also records from `localhost` |

`window.tallymark` has `track(name, props?, value?)` and `pageview()`. An element with `data-tally="Name"` sends that event when clicked, and `data-tally-<name>="value"` attributes become its properties.

The script ignores automated browsers (`navigator.webdriver`) and any browser where `localStorage.tallymark_ignore` is `'true'`.

In React, `<Analytics api="…" outbound downloads />` loads the script once, and `track(name, props?, value?)` sends an event.

## The HTTP API

Mount the handler anywhere: `tm.handle(request)` takes a `Request` and returns a `Response`. Routes are relative to `basePath`.

### Public

| Route | Purpose |
|---|---|
| `POST /collect` | Record a hit. JSON body: `url` (required), `name`, `referrer`, `props`, `value`. The script also sends `w` (window width), `d` (engaged milliseconds) and `s` (scroll depth). Send it as `text/plain` to avoid a CORS preflight. |
| `GET /script.js` | The browser script |
| `GET /health` | `{ "ok": true }` |

`/collect` answers `202` whether the hit was recorded or deliberately ignored. Other answers: `400` not JSON, `403` origin not allowed, `413` over 8 KB, `422` invalid URL, `429` rate limited, `503` the store is down (retry).

### Authenticated

Send `Authorization: Bearer <apiKey>`. All answer `{ "ok": true, "data": … }`.

| Route | Parameters |
|---|---|
| `GET /api/summary` | range, filters |
| `GET /api/compare` | range, filters |
| `GET /api/timeseries` | range, filters, `interval=hour\|day\|week\|month` |
| `GET /api/top` | `by` (any dimension), `limit` (1 to 100), range, filters |
| `GET /api/funnel` | `steps=/pricing,/docs/*,event:Signup` (2 to 10), range, filters |
| `GET /api/sessions` | `limit` (1 to 500, default 50), range, filters |
| `GET /api/journeys` | `depth` (1 to 10, default 3), `limit` (1 to 100, default 10), range, filters |
| `GET /api/realtime` | none |
| `GET /api/events` | `limit` (up to 5000, default 100), range, filters |
| `GET /api/export.csv`, `GET /api/export.ndjson` | range, filters |
| `POST /api/import` | NDJSON body, up to 32 MB |

**Range** is `range=1h\|24h\|7d\|30d\|90d\|365d` (default `7d`), or `from=` and `to=` as an ISO date or epoch milliseconds. **Filters** are query parameters named after a dimension: `?country=DE&device=mobile&prop:plan=pro`. A bad parameter is a `400`, never a `500`.

```bash
curl -H "Authorization: Bearer $KEY" "https://stats.example.com/api/top?by=channel&range=30d"
curl -H "Authorization: Bearer $KEY" "https://stats.example.com/api/top?by=prop:plan&event=Signup&range=30d"
```

## The command line

`bunx tallymark` runs the whole thing as a server. It needs Bun. Configuration is by environment variable.

| Variable | Meaning |
|---|---|
| `PORT` | Default `3000` |
| `TALLYMARK_SECRET`, `TALLYMARK_API_KEY` | The `secret` and `apiKey` options |
| `TALLYMARK_DB` | `./tallymark.db` (SQLite, the default), `:memory:`, or `postgres://user:pass@host/db` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Use Upstash Redis instead (takes priority over `TALLYMARK_DB`) |
| `TALLYMARK_ORIGINS`, `TALLYMARK_HOSTS`, `TALLYMARK_EXCLUDE_IPS`, `TALLYMARK_BLOCKED_REFERRERS` | Comma-separated lists |
| `TALLYMARK_STRICT_ORIGIN` | `true` to enable `strictOrigin` (requires `TALLYMARK_HOSTS`) |
| `TALLYMARK_RETENTION_DAYS` | Delete older events, checked at boot and daily |
| `TALLYMARK_TRUST_PROXY` | `true` only behind a proxy you control. By default the socket address is used. |
| `TALLYMARK_WEBHOOK_URL`, `TALLYMARK_WEBHOOK_SECRET` | Forward every event to a URL |

Invalid values stop it at startup with a clear message. `SIGTERM` finishes in-flight requests and closes the database.

## Backups, forwarding and hooks

```ts
import { createTallymark, mirrorStore, webhookSink } from 'tallymark'

createTallymark({
  // Every event goes to the primary, then to each backup. A backup failing never fails the hit.
  store: mirrorStore(primary, [backup], { onError: (error, i) => log(error, i) }),

  // Every recorded event is also POSTed, signed with HMAC-SHA256, to your URL. Retried on 5xx.
  forward: webhookSink({ url: 'https://hooks.example.com/tallymark', secret: 'whsec_…' }),

  onError: (error, { where }) => log(where, error), // where: 'track' | 'handle' | 'prune'
})
```

Verify a delivery with `verifyWebhookSignature(secret, rawBody, request.headers.get('x-tallymark-signature'))`.

Move data between stores with `await other.import(await tm.export('365d'))`. Imports validate each line and skip anything malformed, and a repeated id is ignored, so a restore can be run twice safely.
