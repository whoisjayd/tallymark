/** Custom event properties. Flat on purpose: easy to store, easy to filter. */
export type Props = Record<string, string | number | boolean>

export type Device = 'desktop' | 'mobile' | 'tablet' | 'unknown'

export interface Utm {
  source: string | null
  medium: string | null
  campaign: string | null
  term: string | null
  content: string | null
}

/** One stored record. Contains no IP address and no raw User-Agent. */
export interface TallymarkEvent {
  id: string
  /** `pageview` is automatic; `event` is a named custom event. */
  type: 'pageview' | 'event' | 'engagement'
  /** `pageview` or `engagement` for those types, otherwise the custom event name. */
  name: string
  /** Unix epoch, milliseconds. */
  ts: number
  /** Daily-rotating anonymous visitor id. Cannot be linked across days. */
  visitor: string
  hostname: string
  path: string
  referrer: string | null
  referrerHost: string | null
  utm: Utm
  /** Browser family, e.g. `Chrome`. */
  browser: string | null
  /** Major version, e.g. `130`. */
  browserVersion: string | null
  os: string | null
  /** Major version. Only for Android and iOS: other user agents are frozen or ambiguous. */
  osVersion: string | null
  device: Device
  country: string | null
  region: string | null
  city: string | null
  /** IANA timezone when the platform provides it, e.g. `Europe/Berlin`. */
  timezone: string | null
  /** Primary language tag from Accept-Language, e.g. `en-US`. */
  language: string | null
  /** Viewport class reported by the tracker. */
  screen: ScreenClass | null
  props: Props
  /** Optional numeric value, e.g. revenue. */
  value: number | null
  /** Engaged milliseconds on the page (tab visible). Only on `engagement` events. */
  duration: number | null
  /** Deepest scroll position reached, 0 to 100. Only on `engagement` events. */
  scroll: number | null
}

/** Viewport width class: mobile < 768, tablet < 1024, laptop < 1440, desktop beyond. */
export type ScreenClass = 'mobile' | 'tablet' | 'laptop' | 'desktop'

export interface ListQuery {
  from: number
  to: number
  /** Hard cap on returned rows. */
  limit?: number
}

/**
 * The only thing tallymark needs from a database. Three methods.
 * Implement it for anything; the built-ins cover memory, D1, SQLite and libSQL.
 */
export interface EventStore {
  insert(event: TallymarkEvent): Promise<void>
  /** Events with `from <= ts < to`, oldest first. */
  list(query: ListQuery): Promise<TallymarkEvent[]>
  /** Delete events older than `before`. Returns the number removed. */
  prune?(before: number): Promise<number>
}

/** Why an incoming hit was not recorded. */
export type IgnoreReason =
  | 'bot'
  | 'dnt'
  | 'invalid'
  | 'rate_limited'
  | 'origin'
  | 'too_large'
  | 'host'
  | 'excluded'
  | 'dnt'
  | 'spam'
  | 'prefetch'
  | 'storage'

export type TrackResult = { ok: true; event: TallymarkEvent } | { ok: false; reason: IgnoreReason }

/** Everything a hit needs, independent of HTTP. Use it for server-side tracking. */
export interface TrackInput {
  /** Event name. Omit (or `pageview`) for a pageview. */
  name?: string
  /** Absolute URL or a path. Query strings are dropped except campaign params. */
  url: string
  referrer?: string | null
  props?: Props
  value?: number
  ip?: string | null
  userAgent?: string | null
  country?: string | null
  region?: string | null
  city?: string | null
  language?: string | null
  timezone?: string | null
  /** Viewport width in CSS pixels; bucketed into a screen class. */
  screenWidth?: number
  /** With `name: 'engagement'`: engaged milliseconds on the page. */
  duration?: number
  /** With `name: 'engagement'`: deepest scroll position, 0 to 100. */
  scroll?: number
  /** Defaults to now. */
  ts?: number
}

/** Per-request connection facts the platform knows and headers cannot be trusted for. */
export interface ConnInfo {
  /** Authoritative client IP, e.g. from Bun's `server.requestIP()`. Wins over proxy headers. */
  ip?: string | null
  /**
   * Run background work (forwarding) without blocking the response. Pass
   * `ctx.waitUntil` on Cloudflare / Vercel; without it, forwarding is awaited.
   */
  waitUntil?: (promise: Promise<unknown>) => void
  /**
   * Authoritative location from the platform (e.g. Cloudflare's `request.cf`).
   * Wins over headers and is applied even when `trustProxy` is false.
   */
  geo?: {
    country?: string | null
    region?: string | null
    city?: string | null
    timezone?: string | null
  }
}

export interface TallymarkOptions {
  /**
   * Secret mixed into visitor hashes. Set a long random string in production.
   * Rotate it to invalidate every visitor id at once. Falls back to a random
   * per-process value, which means ids change on every restart.
   */
  secret?: string
  /** Where events go. Defaults to a bounded in-memory store: no database needed. */
  store?: EventStore
  /** Bearer token for the read API. Unset = the read API is disabled. */
  apiKey?: string
  /** Origins allowed to POST /collect from a browser. `*` allows any. Default `*`. */
  allowedOrigins?: string[] | '*'
  /** Only record hits for these hostnames. Default: any. */
  allowedHosts?: string[]
  /** Honour Do-Not-Track and Global Privacy Control. Default `true`. */
  respectDnt?: boolean
  /** Per-IP limit on /collect. `false` disables. Default 120 hits / minute. */
  rateLimit?: { max: number; windowMs: number } | false
  /** Read client IP / geo from proxy headers (Cloudflare, Vercel, nginx). Default `true`. */
  trustProxy?: boolean
  /** URL prefix the handler is mounted at, e.g. `/api/analytics`. Default `''`. */
  basePath?: string
  /** Delete events older than this many days when `prune()` runs. Default 0 = keep. */
  retentionDays?: number
  /** Inactivity gap that starts a new session, in minutes. Default 30. */
  sessionMinutes?: number
  /** Drop hits from these IPs (your own, health checks). Exact match. */
  excludeIps?: string[]
  /** Extra referrer hosts to treat as spam, on top of the built-in list. Suffix match. */
  blockedReferrers?: string[]
  /**
   * Require the browser's Origin (or Referer) host to be one of `allowedHosts`.
   * Stops other websites from injecting hits via a visitor's browser. Needs `allowedHosts`.
   */
  strictOrigin?: boolean
  /**
   * Send every recorded event to a third party as well (webhook, queue, another
   * analytics tool). Runs after the event is stored; failures go to `onError`
   * and never fail the hit. See `webhookSink()`.
   */
  forward?: (event: TallymarkEvent) => void | Promise<void>
  /** Called on swallowed failures (storage errors, handler exceptions). Wire it to your logger. */
  onError?: (error: unknown, context: { where: 'track' | 'handle' | 'prune' }) => void
  /** Clock override, for tests. */
  now?: () => number
}

// ── Query / response types ────────────────────────────────────────────────

/** Every built-in dimension. Pass to `top()`, or use as a filter. */
export type StaticDimension =
  | 'path'
  | 'referrer' // external referrer host
  | 'source' // utm_source, else referrer host, else Direct
  | 'channel' // Direct, Organic Search, Social, Email, Paid, Campaign, Referral
  | 'country'
  | 'continent'
  | 'region'
  | 'city'
  | 'timezone'
  | 'language'
  | 'browser'
  | 'browser_version'
  | 'os'
  | 'os_version'
  | 'device'
  | 'screen'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_term'
  | 'utm_content'
  | 'event'
  | 'hostname'
  | 'weekday' // Mon..Sun, UTC
  | 'hour' // 00..23, UTC

/** A built-in dimension, or `prop:<name>` for any custom event property, e.g. `prop:plan`. */
export type Dimension = StaticDimension | `prop:${string}`

/** Dimensions `top()` can group by. Entry/exit pages are derived from sessions. */
export type TopDimension = Dimension | 'entry_page' | 'exit_page'

export type Filters = Partial<Record<Dimension, string>>

export interface Range {
  from: number
  to: number
}

export type RangeInput = Range | '1h' | '24h' | '7d' | '30d' | '90d' | '365d'

export interface Summary {
  range: Range
  pageviews: number
  visitors: number
  sessions: number
  events: number
  /** Sum of the `value` of custom events (revenue). */
  revenue: number
  /** 0..1. Sessions with exactly one pageview and no custom events. */
  bounceRate: number
  /** Average session length in seconds, including time on the last page when the tracker reports it. */
  avgSessionSeconds: number
  /** Average time on page in seconds (engaged time when reported, else time to the next hit). */
  avgTimeOnPageSeconds: number
  viewsPerSession: number
}

export type Interval = 'hour' | 'day' | 'week' | 'month'

export interface TimePoint {
  /** Bucket start, epoch ms (UTC). */
  t: number
  pageviews: number
  visitors: number
  events: number
}

export interface TopRow {
  key: string
  visitors: number
  /** Pageviews, or event count when `by = 'event'`. */
  count: number
  /** Sum of `value`, only present when `by = 'event'`. */
  value?: number
  /** Average time on page in seconds. Only for `by = 'path'`. */
  seconds?: number
  /** Average deepest scroll position, 0 to 100. Only for `by = 'path'`, when reported. */
  scroll?: number
}

export interface Realtime {
  windowMinutes: number
  visitors: number
  pageviews: number
  topPaths: TopRow[]
}

export interface Delta {
  current: number
  previous: number
  /** Relative change vs. previous, or null when the previous value was 0. */
  change: number | null
}

export interface Comparison {
  current: Summary
  previous: Summary
  delta: {
    pageviews: Delta
    visitors: Delta
    sessions: Delta
    events: Delta
    revenue: Delta
    bounceRate: Delta
    avgSessionSeconds: Delta
  }
}

/** One funnel step: a page path, or a custom event name. */
export type FunnelStep = { path: string } | { event: string }

export interface FunnelRow {
  step: number
  label: string
  /** Visitors who completed this step after completing every earlier one, in order. */
  visitors: number
  /** Share of the first step, 0..1. */
  rate: number
  /** Share lost since the previous step, 0..1. */
  dropoff: number
}

/** One step of a session, in order: a page viewed or a custom event fired. */
export interface SessionStep {
  t: number
  type: 'pageview' | 'event'
  path: string
  /** Custom events only. */
  name?: string
  value?: number
  /** Pageviews only: seconds on the page, if known. */
  seconds?: number
  /** Pageviews only: deepest scroll position, if reported. */
  scroll?: number
}

/** A visitor's journey through the site, rebuilt from their hits. Anonymous, one day at most. */
export interface SessionTrace {
  id: string
  start: number
  /** Last known activity. */
  end: number
  seconds: number
  pages: number
  entry: string | null
  exit: string | null
  source: string
  channel: string
  country: string | null
  device: Device
  browser: string | null
  os: string | null
  language: string | null
  screen: ScreenClass | null
  revenue: number
  steps: SessionStep[]
}

/** A common route through the site: the first pages of a session, in order. */
export interface Journey {
  steps: string[]
  sessions: number
  /** Share of sessions with at least one pageview, 0..1. */
  share: number
}
