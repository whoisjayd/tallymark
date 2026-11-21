import { continentOf } from './hit.js'
import type {
  Comparison,
  Delta,
  Dimension,
  Filters,
  FunnelRow,
  FunnelStep,
  Interval,
  Journey,
  Range,
  Realtime,
  SessionStep,
  SessionTrace,
  StaticDimension,
  Summary,
  TallymarkEvent,
  TimePoint,
  TopDimension,
  TopRow,
} from './types.js'

/**
 * Pure aggregation. Takes events, returns typed answers. No I/O, no database,
 * so it runs anywhere and is trivial to test.
 */

const HOUR = 3_600_000
const DAY = 86_400_000
const MAX_BUCKETS = 2000
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// ── Dimensions ────────────────────────────────────────────────────────────

export const DIMENSIONS: readonly StaticDimension[] = [
  'path',
  'referrer',
  'source',
  'channel',
  'country',
  'continent',
  'region',
  'city',
  'timezone',
  'language',
  'browser',
  'browser_version',
  'os',
  'os_version',
  'device',
  'screen',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'event',
  'hostname',
  'weekday',
  'hour',
]

/** Everything `top()` accepts: the dimensions, plus entry/exit pages derived from sessions. */
export const TOP_DIMENSIONS: readonly TopDimension[] = [...DIMENSIONS, 'entry_page', 'exit_page']

const PROP = /^prop:[A-Za-z0-9_.-]{1,40}$/

/** A built-in dimension or a `prop:<name>` custom property. */
export const isDimension = (d: string): d is Dimension =>
  (DIMENSIONS as readonly string[]).includes(d) || PROP.test(d)

const SEARCH = [
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'baidu',
  'yandex',
  'ecosia',
  'brave',
  'startpage',
  'qwant',
  'kagi',
  'naver',
  'seznam',
]
const SOCIAL = [
  'facebook',
  'instagram',
  'twitter',
  'x.com',
  't.co',
  'linkedin',
  'lnkd.in',
  'reddit',
  'youtube',
  'pinterest',
  'tiktok',
  'threads',
  'mastodon',
  'bsky',
  'whatsapp',
  'telegram',
  'discord',
  'news.ycombinator.com',
]

/**
 * `google` matches google.com and www.google.co.uk, where the only labels after
 * the brand are a TLD. `google.evil.com` does not: `evil` is someone else's site.
 * `x.com` matches that host and its subdomains.
 */
const hostIs = (host: string, names: string[]) => {
  const h = host.toLowerCase()
  return names.some((n) => {
    if (n.includes('.')) return h === n || h.endsWith(`.${n}`)
    const labels = h.split('.')
    for (let i = labels.length - 1; i >= 0; i--) {
      if (labels[i] !== n) continue
      const rest = labels.slice(i + 1)
      const head = rest[0]
      if (rest.length === 1 || (rest.length === 2 && head !== undefined && head.length <= 3))
        return true
    }
    return false
  })
}

/** Where a visit came from, in the usual marketing buckets. */
function channelOf(e: TallymarkEvent): string {
  const medium = e.utm.medium?.toLowerCase() ?? ''
  const host = e.referrerHost
  if (/^(cpc|ppc|paid|paidsearch|paid-social|display|cpm|banner|retargeting)/.test(medium))
    return 'Paid'
  if (/^(e-?mail|newsletter)/.test(medium) || /^(e-?mail|newsletter)$/i.test(e.utm.source ?? ''))
    return 'Email'
  if (medium === 'social' || (host && hostIs(host, SOCIAL))) return 'Social'
  if (host && hostIs(host, SEARCH)) return 'Organic Search'
  if (host) return 'Referral'
  if (e.utm.source || e.utm.campaign || e.utm.medium) return 'Campaign'
  return 'Direct'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dimensionValue(e: TallymarkEvent, d: Dimension): string | null {
  switch (d) {
    case 'path':
      return e.path
    case 'referrer':
      return e.referrerHost
    case 'source':
      return e.utm.source ?? e.referrerHost ?? 'Direct'
    case 'channel':
      return channelOf(e)
    case 'country':
      return e.country
    case 'continent':
      return continentOf(e.country)
    case 'region':
      return e.region
    case 'city':
      return e.city
    case 'timezone':
      return e.timezone
    case 'language':
      return e.language
    case 'browser':
      return e.browser
    case 'browser_version':
      return e.browser && e.browserVersion ? `${e.browser} ${e.browserVersion}` : null
    case 'os':
      return e.os
    case 'os_version':
      return e.os && e.osVersion ? `${e.os} ${e.osVersion}` : null
    case 'device':
      return e.device === 'unknown' ? null : e.device
    case 'screen':
      return e.screen
    case 'utm_source':
      return e.utm.source
    case 'utm_medium':
      return e.utm.medium
    case 'utm_campaign':
      return e.utm.campaign
    case 'utm_term':
      return e.utm.term
    case 'utm_content':
      return e.utm.content
    case 'event':
      return e.type === 'event' ? e.name : null
    case 'hostname':
      return e.hostname || null
    case 'weekday':
      return WEEKDAYS[new Date(e.ts).getUTCDay()] ?? null
    case 'hour':
      return String(new Date(e.ts).getUTCHours()).padStart(2, '0')
    default: {
      // prop:<name>
      const v = e.props[d.slice(5)]
      return v === undefined ? null : String(v)
    }
  }
}

export function applyFilters(events: TallymarkEvent[], filters: Filters): TallymarkEvent[] {
  const entries = Object.entries(filters).filter(([, v]) => v !== undefined && v !== '') as [
    Dimension,
    string,
  ][]
  if (entries.length === 0) return events
  return events.filter((e) => entries.every(([d, v]) => dimensionValue(e, d) === v))
}

/**
 * Only a session's entry pageview carries a referrer or campaign. Let every later hit
 * (pages, custom events, engagement beacons) inherit it, so a visitor who arrived from
 * Google counts as Google for the whole visit, and "revenue by source" works.
 * A hit that brings its own source (a new campaign landing) replaces the inherited one,
 * and a new session starts after `gapMs` of inactivity.
 */
export function inheritAttribution(
  events: TallymarkEvent[],
  gapMs = 30 * 60_000,
): TallymarkEvent[] {
  const byVisitor = new Map<string, TallymarkEvent[]>()
  for (const e of events) {
    const list = byVisitor.get(e.visitor)
    if (list) list.push(e)
    else byVisitor.set(e.visitor, [e])
  }
  const resolved = new Map<TallymarkEvent, TallymarkEvent>()
  for (const list of byVisitor.values()) {
    list.sort((a, b) => a.ts - b.ts)
    let source: Pick<TallymarkEvent, 'referrer' | 'referrerHost' | 'utm'> | null = null
    let last = -Infinity
    for (const e of list) {
      if (e.ts - last > gapMs) source = null
      last = e.ts
      const own =
        e.referrerHost ||
        e.utm.source ||
        e.utm.medium ||
        e.utm.campaign ||
        e.utm.term ||
        e.utm.content
      if (own) source = { referrer: e.referrer, referrerHost: e.referrerHost, utm: e.utm }
      else if (source) resolved.set(e, { ...e, ...source })
    }
  }
  return events.map((e) => resolved.get(e) ?? e)
}

// ── Sessions ──────────────────────────────────────────────────────────────

interface Session {
  /** Pageviews and custom events, in order. Engagement beacons are folded into `engaged`. */
  hits: TallymarkEvent[]
  engaged: Map<TallymarkEvent, { ms: number; scroll: number | null }>
  /** Last known activity, including time spent reading the last page. */
  end: number
}

/** Latest pageview of the same path. A later beacon replaces an earlier one. */
function attachEngagement(cur: Session, e: TallymarkEvent): boolean {
  for (let i = cur.hits.length - 1; i >= 0; i--) {
    const h = cur.hits[i]!
    if (h.type === 'pageview' && h.path === e.path) {
      const prev = cur.engaged.get(h)
      cur.engaged.set(h, {
        ms: Math.max(prev?.ms ?? 0, e.duration ?? 0),
        scroll: e.scroll ?? prev?.scroll ?? null,
      })
      return true
    }
  }
  return false
}

/** Group a visitor's hits into sessions split by an inactivity gap. */
function sessionize(events: TallymarkEvent[], gapMs: number): Session[] {
  const byVisitor = new Map<string, TallymarkEvent[]>()
  for (const e of events) {
    const list = byVisitor.get(e.visitor)
    if (list) list.push(e)
    else byVisitor.set(e.visitor, [e])
  }
  const sessions: Session[] = []
  for (const list of byVisitor.values()) {
    list.sort((a, b) => a.ts - b.ts)
    let cur: Session | null = null
    for (const e of list) {
      if (e.type === 'engagement') {
        // The beacon is the delayed end of a page, sent when the reader leaves.
        // It must not open a session of its own: a 45 minute article would
        // otherwise look like 30 minutes of silence and lose its reading time.
        if (cur && attachEngagement(cur, e)) cur.end = Math.max(cur.end, e.ts)
        continue
      }
      if (!cur || e.ts - cur.end > gapMs) {
        if (cur) sessions.push(cur)
        cur = { hits: [], engaged: new Map(), end: e.ts }
      }
      cur.end = Math.max(cur.end, e.ts)
      cur.hits.push(e)
    }
    if (cur) sessions.push(cur)
  }
  // An engagement beacon whose pageview is outside the range leaves an empty session.
  return sessions.filter((s) => s.hits.length > 0)
}

/** Seconds on a pageview: engaged time when the tracker reported it, else the time to the next hit. */
function pageSeconds(s: Session, i: number): number | null {
  const h = s.hits[i]!
  const eng = s.engaged.get(h)
  if (eng) return eng.ms / 1000
  const next = s.hits[i + 1]
  return next ? (next.ts - h.ts) / 1000 : null
}

export function summary(events: TallymarkEvent[], range: Range, sessionMinutes = 30): Summary {
  const sessions = sessionize(events, sessionMinutes * 60_000)

  let pageviews = 0
  let customEvents = 0
  let revenue = 0
  for (const e of events) {
    if (e.type === 'pageview') pageviews++
    else if (e.type === 'event') {
      customEvents++
      revenue += e.value ?? 0
    }
  }

  let bounces = 0
  let lengthSum = 0
  let lengthN = 0
  let pageSum = 0
  let pageN = 0
  for (const s of sessions) {
    if (s.hits.length === 1 && s.hits[0]!.type === 'pageview') bounces++
    const length = (s.end - s.hits[0]!.ts) / 1000
    if (length > 0) {
      lengthSum += length
      lengthN++
    }
    s.hits.forEach((h, i) => {
      if (h.type !== 'pageview') return
      const sec = pageSeconds(s, i)
      if (sec !== null) {
        pageSum += sec
        pageN++
      }
    })
  }

  return {
    range,
    pageviews,
    // A beacon is not a visit. Counting it would report a visitor with no pageview and no session.
    visitors: new Set(events.filter((e) => e.type !== 'engagement').map((e) => e.visitor)).size,
    sessions: sessions.length,
    events: customEvents,
    revenue: round(revenue, 2),
    bounceRate: sessions.length ? round(bounces / sessions.length, 4) : 0,
    avgSessionSeconds: lengthN ? Math.round(lengthSum / lengthN) : 0,
    avgTimeOnPageSeconds: pageN ? Math.round(pageSum / pageN) : 0,
    viewsPerSession: sessions.length ? round(pageviews / sessions.length, 2) : 0,
  }
}

// ── Time series ───────────────────────────────────────────────────────────

const STEP: Record<Interval, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY }
const COARSER: Record<Interval, Interval> = {
  hour: 'day',
  day: 'week',
  week: 'month',
  month: 'month',
}

/** UTC bucket start. Weeks begin on Monday. */
function bucketStart(t: number, interval: Interval): number {
  if (interval === 'hour') return Math.floor(t / HOUR) * HOUR
  const day = Math.floor(t / DAY)
  if (interval === 'day') return day * DAY
  if (interval === 'week') return (day - ((day + 3) % 7)) * DAY // 1970-01-01 was a Thursday
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function nextBucket(t: number, interval: Interval): number {
  if (interval === 'month') {
    const d = new Date(t)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
  return t + STEP[interval]
}

export const autoInterval = (r: Range): Interval => {
  const span = r.to - r.from
  return span <= 2 * DAY ? 'hour' : span <= 120 * DAY ? 'day' : 'week'
}

export function timeseries(
  events: TallymarkEvent[],
  range: Range,
  interval: Interval = autoInterval(range),
): TimePoint[] {
  // Never allocate an unbounded number of buckets: coarsen, then clamp the start.
  while (interval !== 'month' && (range.to - range.from) / STEP[interval] > MAX_BUCKETS)
    interval = COARSER[interval]
  const from = Math.max(range.from, range.to - MAX_BUCKETS * STEP[interval])

  const buckets = new Map<number, { pv: number; ev: number; v: Set<string> }>()
  for (let t = bucketStart(from, interval); t < range.to; t = nextBucket(t, interval)) {
    buckets.set(t, { pv: 0, ev: 0, v: new Set() })
  }
  for (const e of events) {
    if (e.type === 'engagement') continue
    const b = buckets.get(bucketStart(e.ts, interval))
    if (!b) continue
    if (e.type === 'pageview') b.pv++
    else b.ev++
    b.v.add(e.visitor)
  }
  return [...buckets.entries()].map(([t, b]) => ({
    t,
    pageviews: b.pv,
    events: b.ev,
    visitors: b.v.size,
  }))
}

// ── Top lists ─────────────────────────────────────────────────────────────

export function top(
  events: TallymarkEvent[],
  by: TopDimension,
  limit = 10,
  sessionMinutes = 30,
): TopRow[] {
  const max = clamp(limit, 1, 100)
  if (by === 'entry_page' || by === 'exit_page') return topPages(events, by, max, sessionMinutes)

  // Custom events, and any `prop:<name>` (properties live on events), are counted as events
  // and their values summed. Everything else counts pageviews.
  const isEvent = by === 'event' || by.startsWith('prop:')
  const rows = new Map<
    string,
    {
      count: number
      value: number
      v: Set<string>
      secSum: number
      secN: number
      scrollSum: number
      scrollN: number
    }
  >()
  const row = (key: string) => {
    let r = rows.get(key)
    if (!r) {
      r = { count: 0, value: 0, v: new Set(), secSum: 0, secN: 0, scrollSum: 0, scrollN: 0 }
      rows.set(key, r)
    }
    return r
  }

  for (const e of events) {
    if (e.type === 'engagement' || e.type !== (isEvent ? 'event' : 'pageview')) continue
    const key = dimensionValue(e, by)
    if (!key) continue
    const r = row(key)
    r.count++
    r.value += e.value ?? 0
    r.v.add(e.visitor)
  }

  // Time on page and scroll depth per path.
  if (by === 'path') {
    for (const s of sessionize(events, sessionMinutes * 60_000)) {
      s.hits.forEach((h, i) => {
        if (h.type !== 'pageview') return
        const r = rows.get(h.path)
        if (!r) return
        const sec = pageSeconds(s, i)
        if (sec !== null) {
          r.secSum += sec
          r.secN++
        }
        const scroll = s.engaged.get(h)?.scroll
        if (scroll !== null && scroll !== undefined) {
          r.scrollSum += scroll
          r.scrollN++
        }
      })
    }
  }

  return [...rows.entries()]
    .map(([key, r]): TopRow => {
      const out: TopRow = { key, visitors: r.v.size, count: r.count }
      if (isEvent) out.value = round(r.value, 2)
      if (by === 'path') {
        if (r.secN) out.seconds = Math.round(r.secSum / r.secN)
        if (r.scrollN) out.scroll = Math.round(r.scrollSum / r.scrollN)
      }
      return out
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, max)
}

/** Entry / exit pages: the first / last pageview of each session. */
function topPages(
  events: TallymarkEvent[],
  by: 'entry_page' | 'exit_page',
  limit: number,
  sessionMinutes: number,
): TopRow[] {
  const rows = new Map<string, { count: number; v: Set<string> }>()
  for (const s of sessionize(events, sessionMinutes * 60_000)) {
    const views = s.hits.filter((e) => e.type === 'pageview')
    const page = by === 'entry_page' ? views[0] : views[views.length - 1]
    if (!page) continue
    let r = rows.get(page.path)
    if (!r) {
      r = { count: 0, v: new Set() }
      rows.set(page.path, r)
    }
    r.count++
    r.v.add(page.visitor)
  }
  return [...rows.entries()]
    .map(([key, r]): TopRow => ({ key, visitors: r.v.size, count: r.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit)
}

// ── Paths travelled ───────────────────────────────────────────────────────

/** Recent sessions, newest first, each with the ordered steps the visitor took. */
export function sessionTraces(
  events: TallymarkEvent[],
  sessionMinutes = 30,
  limit = 50,
): SessionTrace[] {
  const recent = sessionize(events, sessionMinutes * 60_000)
    .sort((a, b) => b.hits[0]!.ts - a.hits[0]!.ts)
    .slice(0, clamp(limit, 1, 500))

  return recent.map((s) => {
    const first = s.hits[0]!
    const views = s.hits.filter((h) => h.type === 'pageview')
    const steps: SessionStep[] = s.hits.map((h, i) => {
      if (h.type === 'event') {
        return {
          t: h.ts,
          type: 'event',
          path: h.path,
          name: h.name,
          ...(h.value !== null && { value: h.value }),
        }
      }
      const seconds = pageSeconds(s, i)
      const scroll = s.engaged.get(h)?.scroll
      return {
        t: h.ts,
        type: 'pageview',
        path: h.path,
        ...(seconds !== null && { seconds: round(seconds, 1) }),
        ...(scroll !== null && scroll !== undefined && { scroll }),
      }
    })
    return {
      id: `${first.visitor.slice(0, 8)}-${first.ts.toString(36)}`,
      start: first.ts,
      end: s.end,
      seconds: Math.round((s.end - first.ts) / 1000),
      pages: views.length,
      entry: views[0]?.path ?? null,
      exit: views[views.length - 1]?.path ?? null,
      source: dimensionValue(first, 'source') ?? 'Direct',
      channel: channelOf(first),
      country: first.country,
      device: first.device,
      browser: first.browser,
      os: first.os,
      language: first.language,
      screen: first.screen,
      revenue: round(
        s.hits.reduce((n, h) => n + (h.type === 'event' ? (h.value ?? 0) : 0), 0),
        2,
      ),
      steps,
    }
  })
}

/** The most common routes through the site: each session's first `depth` pages, in order. */
export function journeys(
  events: TallymarkEvent[],
  sessionMinutes = 30,
  depth = 3,
  limit = 10,
): Journey[] {
  const counts = new Map<string, { steps: string[]; n: number }>()
  let total = 0
  for (const s of sessionize(events, sessionMinutes * 60_000)) {
    const path: string[] = []
    for (const h of s.hits) {
      if (h.type === 'pageview' && path[path.length - 1] !== h.path) path.push(h.path) // a reload is not a step
    }
    if (path.length === 0) continue
    total++
    const steps = path.slice(0, clamp(depth, 1, 10))
    const key = steps.join('\n')
    const c = counts.get(key)
    if (c) c.n++
    else counts.set(key, { steps, n: 1 })
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.steps.join().localeCompare(b.steps.join()))
    .slice(0, clamp(limit, 1, 100))
    .map((c) => ({ steps: c.steps, sessions: c.n, share: round(c.n / total, 4) }))
}

// ── Comparison, funnel, realtime, CSV ─────────────────────────────────────

const delta = (current: number, previous: number): Delta => ({
  current,
  previous,
  change: previous === 0 ? null : round((current - previous) / previous, 4),
})

export function compare(current: Summary, previous: Summary): Comparison {
  return {
    current,
    previous,
    delta: {
      pageviews: delta(current.pageviews, previous.pageviews),
      visitors: delta(current.visitors, previous.visitors),
      sessions: delta(current.sessions, previous.sessions),
      events: delta(current.events, previous.events),
      revenue: delta(current.revenue, previous.revenue),
      bounceRate: delta(current.bounceRate, previous.bounceRate),
      avgSessionSeconds: delta(current.avgSessionSeconds, previous.avgSessionSeconds),
    },
  }
}

const stepLabel = (s: FunnelStep) => ('path' in s ? s.path : `event:${s.event}`)

function stepMatches(e: TallymarkEvent, s: FunnelStep): boolean {
  if ('event' in s) return e.type === 'event' && e.name === s.event
  if (e.type !== 'pageview') return false
  // A trailing `*` is a prefix match: `/docs/*`.
  return s.path.endsWith('*') ? e.path.startsWith(s.path.slice(0, -1)) : e.path === s.path
}

/**
 * Ordered funnel. A visitor counts for step N only if they hit steps 1..N in
 * order. Visitor ids rotate daily by design, so a funnel measures within-day journeys.
 */
export function funnel(events: TallymarkEvent[], steps: FunnelStep[]): FunnelRow[] {
  if (steps.length === 0) return []
  const byVisitor = new Map<string, TallymarkEvent[]>()
  for (const e of events) {
    const l = byVisitor.get(e.visitor)
    if (l) l.push(e)
    else byVisitor.set(e.visitor, [e])
  }
  const reached = new Array<number>(steps.length).fill(0)
  for (const list of byVisitor.values()) {
    list.sort((a, b) => a.ts - b.ts)
    let i = 0
    for (const e of list) {
      if (i < steps.length && stepMatches(e, steps[i]!)) i++
    }
    for (let k = 0; k < i; k++) reached[k]!++
  }
  return steps.map((s, k) => ({
    step: k + 1,
    label: stepLabel(s),
    visitors: reached[k]!,
    rate: reached[0] ? round(reached[k]! / reached[0]!, 4) : 0,
    dropoff: k === 0 || !reached[k - 1] ? 0 : round(1 - reached[k]! / reached[k - 1]!, 4),
  }))
}

export function realtime(events: TallymarkEvent[], now: number, windowMinutes = 5): Realtime {
  const live = events.filter((e) => e.ts >= now - windowMinutes * 60_000 && e.type !== 'engagement')
  return {
    windowMinutes,
    visitors: new Set(live.map((e) => e.visitor)).size,
    pageviews: live.filter((e) => e.type === 'pageview').length,
    topPaths: top(live, 'path', 5),
  }
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v)
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(events: TallymarkEvent[]): string {
  const head = [
    'time',
    'type',
    'name',
    'path',
    'hostname',
    'referrer',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'browser',
    'browser_version',
    'os',
    'os_version',
    'device',
    'screen',
    'country',
    'region',
    'city',
    'timezone',
    'language',
    'value',
    'duration_ms',
    'scroll',
    'props',
    'visitor',
  ]
  const lines = events.map((e) =>
    [
      new Date(e.ts).toISOString(),
      e.type,
      e.name,
      e.path,
      e.hostname,
      e.referrerHost,
      e.utm.source,
      e.utm.medium,
      e.utm.campaign,
      e.utm.term,
      e.utm.content,
      e.browser,
      e.browserVersion,
      e.os,
      e.osVersion,
      e.device,
      e.screen,
      e.country,
      e.region,
      e.city,
      e.timezone,
      e.language,
      e.value,
      e.duration,
      e.scroll,
      Object.keys(e.props).length ? JSON.stringify(e.props) : '',
      e.visitor,
    ]
      .map(csvCell)
      .join(','),
  )
  return `${[head.join(','), ...lines].join('\n')}\n`
}
