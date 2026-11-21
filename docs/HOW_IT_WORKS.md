# HOW IT WORKS

This page explains what Tallymark records, how it counts people without cookies, and where its limits are. For how to call it, see [USAGE.md](./USAGE.md).

## The life of a hit

1. **A hit arrives.** Either the browser script sends it to `/collect`, or your server code calls `track()` or `trackRequest()`.
2. **It is checked.** Bots, Do-Not-Track and Global Privacy Control, browser prefetches, your own excluded IPs, referrer spam, hosts you did not allow, and oversize or malformed bodies are dropped. A dropped hit is not an error: the endpoint still answers `202`, so a scraper learns nothing about what tripped it.
3. **It is cleaned.** The URL is reduced to hostname, path and campaign parameters (every other query parameter is discarded, because they often carry tokens). The User-Agent becomes a browser, a version, an OS and a device class. The IP and the platform's geo headers become a country, region, city and timezone. The language header becomes one tag such as `en-US`.
4. **The visitor is hashed.** See below. The raw IP and User-Agent are used here and then forgotten.
5. **The event is stored.** One row, or one sorted-set entry, in the store you chose.
6. **Questions are answered later.** `summary()`, `top()`, `sessions()` and the rest read events from the store for the range you ask about and compute the answer in memory.

## What an event contains

| Field | Meaning |
|---|---|
| `type`, `name` | `pageview`, a custom `event` (and its name), or an `engagement` beacon (time on a page) |
| `ts` | When it happened, in milliseconds |
| `visitor` | The anonymous daily hash |
| `hostname`, `path` | Which site and page. No query string except campaign parameters. |
| `referrer`, `referrerHost` | The external site the visitor came from, if any |
| `utm` | `source`, `medium`, `campaign`, `term`, `content` from the URL |
| `browser`, `browserVersion` | `Chrome`, `130` |
| `os`, `osVersion` | `Windows`; the version is kept only for Android and iOS, because other user agents hide it |
| `device`, `screen` | `desktop` / `mobile` / `tablet`; and `mobile` / `tablet` / `laptop` / `desktop` from the window width |
| `country`, `region`, `city`, `timezone` | From your host's headers. Coarse, never coordinates. |
| `language` | The primary tag of `Accept-Language` |
| `props`, `value` | Properties and a number you attached to a custom event |
| `duration`, `scroll` | On `engagement` events: seconds on the page and how far it was scrolled |

An event never contains an IP address, a raw User-Agent, a cookie, or a user id.

## The visitor

```
visitor = sha256( secret : UTC date : hostname : IP : User-Agent )
```

- **No cookies and no storage.** Nothing is written to the visitor's device. The same inputs give the same hash, so repeat hits are recognised without remembering anyone.
- **It resets at midnight UTC.** The date is an input, so the same person looks like a different visitor tomorrow. This is deliberate: it is what stops anyone from following a person across days.
- **It differs per site.** The hostname is an input, so one person on two of your sites is two visitors.
- **Your `secret` matters.** Anyone who has it and can guess an IP and a User-Agent could recompute that visitor's hash. Keep it private. Changing it makes every existing visitor look new.

Consequences you should know about:

- "Unique visitors" over several days is the sum of each day's unique visitors, not true uniques.
- There are no "returning visitors" reports and no long-term cohorts. That is the cost of not tracking people.
- People who share an IP and have an identical User-Agent (an office, a school) count as one.
- Funnels and session paths cover a single day. A session that crosses midnight UTC becomes two.

## The session

A session is one visit. Events from the same visitor belong to the same session until they are quiet for 30 minutes (`sessionMinutes`). Sessions are not stored; they are rebuilt from events whenever a question needs them. That is how Tallymark answers:

- **Bounce rate**: the share of sessions that were a single pageview.
- **Time on site**: from the first event to the last sign of activity, including time spent reading the last page.
- **Entry and exit pages**: the first and last pageview of each session.
- **The path travelled**: the ordered pages and events of a session, with seconds and scroll depth per page. `sessions()` returns these, and `journeys()` counts the most common routes.

## Where a visit came from

Only a session's first page carries a referrer or a campaign, so the rest of the visit inherits it. A visitor who arrives from Google and views five pages is one Google visitor, and a purchase they make is credited to Google. A page that brings its own campaign (a new `?utm_*` landing) replaces the inherited source, and a new session after 30 quiet minutes starts fresh.

The **channel** is derived from the source:

| Channel | When |
|---|---|
| Paid | `utm_medium` is `cpc`, `ppc`, `paid…`, `display`, `cpm`, `banner` or `retargeting` |
| Email | `utm_medium` is `email` or `newsletter`, or `utm_source` is `email` or `newsletter` |
| Social | `utm_medium=social`, or the referrer is a known social site (Facebook, X, LinkedIn, Reddit, YouTube, Hacker News, …) |
| Organic Search | The referrer is a known search engine (Google, Bing, DuckDuckGo, Yahoo, Baidu, Yandex, Ecosia, Brave, …) |
| Referral | Any other referring site |
| Campaign | A `utm_*` parameter with no referrer |
| Direct | None of the above |

The **source** is `utm_source` when present, else the referring host, else `Direct`.

## Time on page and scroll depth

The browser script measures *engaged* time: seconds the tab was visible. It also tracks the deepest scroll position. When the page is hidden, left, or replaced by a single-page-app navigation, it sends one `engagement` beacon with the running total. A later beacon for the same page replaces the earlier one, so the total is cumulative and a tab that goes to the background does not count the time it was away.

Engagement beacons are stored as events of their own type, but they are not pageviews or custom events: they never change visitor, pageview, event or bounce counts. They only add time and scroll to the page they belong to. Turn them off with `data-engagement="false"`, which also removes one stored row per pageview.

Without the script (for example, server-side tracking only), time on a page falls back to the gap to the visitor's next hit. The last page of a session has no next hit, so its time is unknown.

## Bots and noise

A request is ignored when the User-Agent looks automated (crawlers, headless browsers, HTTP libraries, uptime monitors), when it carries `DNT: 1` or `Sec-GPC: 1` (turn this off with `respectDnt: false`), when it is a browser prefetch or prerender, when the IP is in `excludeIps`, when the referrer is on a spam list (`blockedReferrers` extends it), or when the host is not in `allowedHosts`. The browser script additionally does nothing in an automated browser (`navigator.webdriver`), on `localhost` unless you ask, or when `localStorage.tallymark_ignore = 'true'` (a way for you to exclude yourself).

## Privacy

Tallymark reduces what you hold; it does not decide whether you need a consent notice. That depends on your jurisdiction, on what you put in event properties, and on whether you forward data to third parties. Check with counsel for your case.

- **Never stored:** IP addresses, raw User-Agents, full query strings, cookies, anything that identifies a person.
- **Kept:** the fields in the table above, which are aggregate-friendly and coarse.
- **Your responsibility:** do not put personal data (emails, names, user ids) into event names or properties. `forward` and `mirrorStore` send events elsewhere; those recipients are part of your privacy story.
- **Retention:** set `retentionDays` and run `prune()` on a schedule (the CLI does it daily; Cloudflare and Vercel have cron helpers). To delete everything, drop the table or the key.

## Limits

- **Not a data warehouse.** A question reads the events in its time range and computes the answer in memory. That is quick up to a few hundred thousand events per question. For very large sites, ask about shorter ranges, or write a store that pre-aggregates.
- **The ingest endpoint is public**, as in every analytics tool, so anyone can send fake events. `allowedHosts`, `strictOrigin`, rate limiting, bot filtering and spam filtering raise the cost of that; they cannot remove it. Put Cloudflare or your platform's rate limiting in front for hard limits. The built-in limiter is per process.
- **Geography needs a host that provides it.** Cloudflare and Vercel send country, region, city and timezone. Elsewhere those fields stay empty unless you pass `country` and friends yourself. Tallymark never calls a third-party geolocation service.
- **Times are UTC.** `weekday`, `hour` and the buckets of `timeseries()` use UTC.
- **ESM only.** There is no CommonJS build.
