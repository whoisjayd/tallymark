import type { ConnInfo, Device, Props, ScreenClass, Utm } from './types.js'

/**
 * Turning a raw request into clean event fields: User-Agent, URL, referrer,
 * language, location, spam, and the anonymous daily visitor id.
 */

// ── User-Agent ────────────────────────────────────────────────────────────────

export interface UaInfo {
  browser: string | null
  browserVersion: string | null
  os: string | null
  osVersion: string | null
  device: Device
  bot: boolean
}

// `(?<!cu)` keeps phone brands such as Cubot. `bot` still matches Googlebot and bingbot.
const BOT =
  /(?<!cu)bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl\/|wget|python-|httpclient|okhttp|monitor|uptime|pingdom|axios|node-fetch|undici|go-http|java\/|libwww|scrapy|phantomjs|selenium|puppeteer|playwright/i

const BROWSERS: Array<[name: string, pattern: RegExp]> = [
  ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /OPR\/(\d+)/],
  ['Samsung Internet', /SamsungBrowser\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /Version\/(\d+).*Safari/],
]

/** Tiny, dependency-free UA parser. Browser family + major version, OS, and device class. */
export function parseUserAgent(ua: string | null | undefined): UaInfo {
  const none: UaInfo = {
    browser: null,
    browserVersion: null,
    os: null,
    osVersion: null,
    device: 'unknown',
    bot: true,
  }
  if (!ua || ua.length < 8 || BOT.test(ua)) return none

  let browser: string | null = null
  let browserVersion: string | null = null
  for (const [name, pattern] of BROWSERS) {
    const m = ua.match(pattern)
    if (m) {
      browser = name
      browserVersion = m[1] ?? null
      break
    }
  }

  // Windows and macOS versions are not recoverable (frozen or shared by several
  // releases), so a version is reported only where the user agent is honest.
  let os: string | null = null
  let osVersion: string | null = null
  if (/Windows/i.test(ua)) os = 'Windows'
  else if (/iPhone|iPad|iPod/i.test(ua)) {
    os = 'iOS'
    osVersion = ua.match(/OS (\d+)[_\d]*/)?.[1] ?? null
  } else if (/Android/i.test(ua)) {
    os = 'Android'
    osVersion = ua.match(/Android (\d+)/)?.[1] ?? null
  } else if (/CrOS/i.test(ua)) os = 'ChromeOS'
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS'
  else if (/Linux|X11/i.test(ua)) os = 'Linux'

  let device: Device = 'desktop'
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) device = 'tablet'
  else if (/Mobi|iPhone|iPod|Android/i.test(ua)) device = 'mobile'

  return { browser, browserVersion, os, osVersion, device, bot: false }
}

// ── URL and referrer ──────────────────────────────────────────────────────────

export interface ParsedUrl {
  hostname: string
  path: string
  utm: Utm
}

const stripWww = (h: string) => h.replace(/^www\./, '').toLowerCase()

const clean = (v: string | null, max = 120): string | null => {
  if (!v) return null
  const t = v.trim().slice(0, max)
  return t === '' ? null : t
}

/**
 * Accepts an absolute URL or a bare path. Keeps only hostname, path and campaign
 * parameters. Every other query parameter is dropped: they often carry tokens or
 * personal data.
 */
export function parseUrl(input: string): ParsedUrl | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return null
  // Only absolute http(s) URLs or rooted paths. A bare word is not a page.
  if (!/^https?:\/\//i.test(input) && !input.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(input, 'http://localhost')
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const q = url.searchParams
  let path = url.pathname.replace(/\/{2,}/g, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)

  return {
    hostname: /^https?:\/\//i.test(input) ? stripWww(url.hostname) : '',
    path: path.slice(0, 300) || '/',
    utm: {
      source: clean(q.get('utm_source') ?? q.get('ref') ?? q.get('source')),
      medium: clean(q.get('utm_medium')),
      campaign: clean(q.get('utm_campaign')),
      term: clean(q.get('utm_term')),
      content: clean(q.get('utm_content')),
    },
  }
}

/** Returns `{ url, host }` for an external referrer, or nulls for internal/invalid. */
export function parseReferrer(
  referrer: string | null | undefined,
  hostname: string,
): { referrer: string | null; host: string | null } {
  if (!referrer) return { referrer: null, host: null }
  try {
    const r = new URL(referrer)
    if (r.protocol !== 'http:' && r.protocol !== 'https:') return { referrer: null, host: null }
    const host = stripWww(r.hostname)
    if (host === hostname) return { referrer: null, host: null }
    return { referrer: `${host}${r.pathname === '/' ? '' : r.pathname}`.slice(0, 200), host }
  } catch {
    return { referrer: null, host: null }
  }
}

// ── Location and client IP ────────────────────────────────────────────────────

export interface Geo {
  country: string | null
  region: string | null
  city: string | null
  timezone: string | null
}

const val = (v: string | null | undefined, max = 80): string | null => {
  if (!v) return null
  let s = v
  try {
    s = decodeURIComponent(v)
  } catch {
    /* keep raw */
  }
  s = s.trim().slice(0, max)
  return s === '' ? null : s
}

/**
 * Location and client IP from headers the hosting platform already sets. Free,
 * instant, and no third-party lookup: Cloudflare, Vercel, and generic proxies.
 *
 * Only trust these when the request really passed through that platform.
 */
/** An IANA timezone such as `Europe/Berlin`, or null. Anything else is dropped. */
export function timezone(v: string | null | undefined): string | null {
  return v && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v) && v.length <= 40 ? v : null
}

export function geoFromHeaders(h: Headers): Geo {
  // Cloudflare. `XX` = unknown, `T1` = Tor.
  const cf = val(h.get('cf-ipcountry'), 8)
  const vercel = val(h.get('x-vercel-ip-country'), 8)
  const raw = (cf ?? vercel ?? val(h.get('x-country-code'), 8))?.toUpperCase() ?? null
  const country = raw && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' && raw !== 'T1' ? raw : null
  return {
    country,
    region: val(h.get('cf-region') ?? h.get('x-vercel-ip-country-region')),
    city: val(h.get('cf-ipcity') ?? h.get('x-vercel-ip-city')),
    timezone: timezone(h.get('cf-timezone') ?? h.get('x-vercel-ip-timezone')),
  }
}

export function clientIp(h: Headers): string | null {
  const direct = h.get('cf-connecting-ip') ?? h.get('x-real-ip')
  const raw = direct ?? h.get('x-forwarded-for')?.split(',')[0]
  if (!raw) return null
  const ip = raw.trim()
  // A forwarded header is attacker-controlled when the proxy did not overwrite it.
  // Anything longer than an IP is not one, and must not become a rate-limit key.
  return ip.length > 0 && ip.length <= 128 ? ip : null
}

// ── Referrer spam ─────────────────────────────────────────────────────────────

/**
 * Well-known referrer spam: bots that fake a Referer so their domain shows up in
 * your reports. Suffix-matched, so `x.semalt.com` is caught too. Extend with the
 * `blockedReferrers` option.
 */
const SPAM = [
  'semalt.com',
  'buttons-for-website.com',
  'darodar.com',
  'floating-share-buttons.com',
  'free-share-buttons.com',
  'simple-share-buttons.com',
  'best-seo-offer.com',
  'best-seo-solution.com',
  'ranksonic.com',
  'savetubevideo.com',
  'kambasoft.com',
  'hulfingtonpost.com',
  'trafficmonetize.org',
  'trafficmonetizer.org',
  'webmonetizer.net',
  'event-tracking.com',
  'get-free-traffic-now.com',
  'sexyali.com',
  'o00o.ooo',
]

export function isSpamReferrer(host: string | null, extra: string[] = []): boolean {
  if (!host) return false
  const h = host.toLowerCase()
  return [...SPAM, ...extra].some((s) => {
    const d = s.toLowerCase().replace(/^www\./, '')
    return h === d || h.endsWith(`.${d}`)
  })
}

// ── Visitor id ────────────────────────────────────────────────────────────────

const enc = new TextEncoder()

async function sha256Hex(input: string, bytes = 16): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return Array.from(new Uint8Array(buf).slice(0, bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/** UTC day number, so the salt flips at 00:00 UTC for everyone. */
const dayOf = (ts: number) => Math.floor(ts / 86_400_000)

/**
 * Anonymous, cookieless visitor id:
 *
 *   sha256(secret : utcDay : hostname : ip : userAgent)
 *
 * The raw IP and User-Agent only exist inside this call. Because the day is part
 * of the input, the same person gets a different id tomorrow and cannot be
 * followed across days. Different sites get different ids for the same person.
 */
export function visitorId(
  secret: string,
  ts: number,
  hostname: string,
  ip: string | null,
  userAgent: string | null,
): Promise<string> {
  return sha256Hex(`${secret}:${dayOf(ts)}:${hostname}:${ip ?? ''}:${userAgent ?? ''}`)
}

export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function randomSecret(): string {
  return randomId() + randomId()
}

// ── Input cleaning ──────────────────────────────────────────────────────────

const MAX_PROPS = 20
const MAX_PROP_KEY = 40
const MAX_PROP_VALUE = 200

/** Keep props flat, small, and primitive. Anything else is dropped, not thrown. */
export function sanitizeProps(input: unknown): Props {
  const out: Props = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  let n = 0
  for (const [k, v] of Object.entries(input)) {
    if (n >= MAX_PROPS) break
    if (k.length === 0 || k.length > MAX_PROP_KEY) continue
    if (typeof v === 'string') out[k] = v.slice(0, MAX_PROP_VALUE)
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else continue
    n++
  }
  return out
}

/** `en-US,en;q=0.9` -> `en-US`. Only the primary tag; never the whole header. */
export function primaryLanguage(header: string | null | undefined): string | null {
  const tag = header?.split(',')[0]?.split(';')[0]?.trim()
  return tag && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(tag) ? tag : null
}

// ── Screen size and continents ──────────────────────────────────────────────

/** Plausible-style viewport classes. Bucketed server-side so raw widths are never stored. */
export function screenClass(width: unknown): ScreenClass | null {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null
  return width < 768 ? 'mobile' : width < 1024 ? 'tablet' : width < 1440 ? 'laptop' : 'desktop'
}

const CONTINENTS: Record<string, string> = {
  Africa:
    'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW',
  Antarctica: 'AQ BV GS HM TF',
  Asia: 'AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE',
  Europe:
    'AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB',
  'North America':
    'AI AG AW BS BB BZ BM BQ VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VI UM',
  Oceania: 'AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV VU WF',
  'South America': 'AR BO BR CL CO EC FK GF GY PY PE SR UY VE',
}

const CONTINENT_OF = new Map<string, string>(
  Object.entries(CONTINENTS).flatMap(([name, codes]) =>
    codes.split(' ').map((c): [string, string] => [c, name]),
  ),
)

/** Continent name for an ISO 3166-1 alpha-2 country code, or null. */
export function continentOf(country: string | null): string | null {
  return country ? (CONTINENT_OF.get(country) ?? null) : null
}

// ── Everything a request tells us ───────────────────────────────────────────

export interface RequestFacts {
  ip: string | null
  userAgent: string | null
  language: string | null
  country: string | null
  region: string | null
  city: string | null
  timezone: string | null
}

/**
 * Read the visitor's IP, User-Agent, language and location from a request. The one
 * place this happens, so the browser endpoint and server-side tracking agree.
 * `info` (the socket address, Cloudflare's `request.cf`) wins over headers.
 */
export function describeRequest(req: Request, info: ConnInfo, trustProxy: boolean): RequestFacts {
  const h = req.headers
  const fromHeaders = trustProxy
    ? geoFromHeaders(h)
    : { country: null, region: null, city: null, timezone: null }
  return {
    ip: info.ip ?? (trustProxy ? clientIp(h) : null),
    userAgent: h.get('user-agent'),
    language: primaryLanguage(h.get('accept-language')),
    country: info.geo?.country ?? fromHeaders.country,
    region: info.geo?.region ?? fromHeaders.region,
    city: info.geo?.city ?? fromHeaders.city,
    timezone: info.geo?.timezone ?? fromHeaders.timezone,
  }
}
