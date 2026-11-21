import type { EventStore, ListQuery, TallymarkEvent } from './types.js'

// ── Memory ────────────────────────────────────────────────────────────────────

/**
 * Zero-dependency store. Events live in process memory and vanish on restart,
 * which is exactly what you want for tests, demos, and "just give me numbers".
 * Bounded, so it can never grow without limit. Keyed by id, like every other store.
 */
export function memoryStore(options: { maxEvents?: number } = {}): EventStore {
  const max = Math.max(1, options.maxEvents ?? 100_000)
  // A Map keeps insertion order, so the first key is always the oldest insert.
  const events = new Map<string, TallymarkEvent>()

  return {
    async insert(event) {
      if (events.has(event.id)) return
      events.set(event.id, event)
      if (events.size > max) events.delete(events.keys().next().value as string)
    },
    async list({ from, to, limit }: ListQuery) {
      const out = [...events.values()]
        .filter((e) => e.ts >= from && e.ts < to)
        .sort((a, b) => a.ts - b.ts)
      return limit ? out.slice(-limit) : out
    },
    async prune(before) {
      let n = 0
      for (const [id, e] of events) {
        if (e.ts < before) {
          events.delete(id)
          n++
        }
      }
      return n
    },
  }
}

// ── SQL: SQLite and PostgreSQL ────────────────────────────────────────────────

export type Dialect = 'sqlite' | 'postgres'

/**
 * One SQL store, many databases. Anything that speaks SQLite or PostgreSQL can
 * plug in by providing two functions. Write SQL with `?` placeholders; the
 * store rewrites them to `$1, $2, ...` for Postgres.
 */
export interface SqlDriver {
  /** Defaults to `sqlite`. */
  dialect?: Dialect
  /** Run a write. Return the number of rows changed (0 if unknown). */
  run(sql: string, params: unknown[]): Promise<number>
  all<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>
}

const COLUMNS = `
    id TEXT PRIMARY KEY,
    ts @INT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    visitor TEXT NOT NULL,
    hostname TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT,
    referrer_host TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
    browser TEXT, browser_version TEXT, os TEXT, os_version TEXT, device TEXT, screen TEXT,
    country TEXT, region TEXT, city TEXT, timezone TEXT, language TEXT,
    props TEXT,
    value @REAL,
    duration @INT,
    scroll @INT`

const schema = (d: Dialect) => [
  `CREATE TABLE IF NOT EXISTS tallymark_events (${COLUMNS}
  )`
    .replaceAll('@INT', d === 'postgres' ? 'BIGINT' : 'INTEGER')
    .replace('@REAL', d === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'),
  'CREATE INDEX IF NOT EXISTS tallymark_events_ts ON tallymark_events (ts)',
]

interface Row {
  id: string
  ts: number | string | bigint
  type: TallymarkEvent['type']
  name: string
  visitor: string
  hostname: string
  path: string
  referrer: string | null
  referrer_host: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_term: string | null
  utm_content: string | null
  browser: string | null
  browser_version: string | null
  os: string | null
  os_version: string | null
  screen: TallymarkEvent['screen']
  timezone: string | null
  duration: number | string | null
  scroll: number | string | null
  device: TallymarkEvent['device'] | null
  country: string | null
  region: string | null
  city: string | null
  language: string | null
  props: string | null
  value: number | string | null
}

function fromRow(r: Row): TallymarkEvent {
  let props: TallymarkEvent['props'] = {}
  if (r.props) {
    try {
      props = JSON.parse(r.props)
    } catch {
      /* corrupt props never break a query */
    }
  }
  return {
    id: r.id,
    // Postgres returns BIGINT as a string; normalise.
    ts: Number(r.ts),
    type: r.type,
    name: r.name,
    visitor: r.visitor,
    hostname: r.hostname,
    path: r.path,
    referrer: r.referrer,
    referrerHost: r.referrer_host,
    utm: {
      source: r.utm_source,
      medium: r.utm_medium,
      campaign: r.utm_campaign,
      term: r.utm_term,
      content: r.utm_content,
    },
    browser: r.browser,
    browserVersion: r.browser_version ?? null,
    os: r.os,
    osVersion: r.os_version ?? null,
    device: r.device ?? 'unknown',
    screen: r.screen ?? null,
    timezone: r.timezone ?? null,
    duration: r.duration === null || r.duration === undefined ? null : Number(r.duration),
    scroll: r.scroll === null || r.scroll === undefined ? null : Number(r.scroll),
    country: r.country,
    region: r.region,
    city: r.city,
    language: r.language ?? null,
    props,
    value: r.value === null || r.value === undefined ? null : Number(r.value),
  }
}

// Order matters: it must match the parameter list in insert().
const COLS = [
  'id',
  'ts',
  'type',
  'name',
  'visitor',
  'hostname',
  'path',
  'referrer',
  'referrer_host',
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
  'props',
  'value',
  'duration',
  'scroll',
]
const INSERT_COLS = `(${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(',')})`

export function sqlStore(driver: SqlDriver): EventStore {
  const dialect = driver.dialect ?? 'sqlite'
  const pg = dialect === 'postgres'

  // `?` -> `$n` for Postgres. None of our SQL contains a literal question mark.
  const sql = (text: string) => {
    if (!pg) return text
    let i = 0
    return text.replace(/\?/g, () => `$${++i}`)
  }
  const run = (text: string, params: unknown[] = []) => driver.run(sql(text), params)
  const all = <T>(text: string, params: unknown[] = []) => driver.all<T>(sql(text), params)

  // Memoised in-flight promise collapses a cold-start stampede into one DDL run.
  // A failure clears it so one blip is not a permanent outage.
  let ready: Promise<void> | null = null
  const ensure = () => {
    ready ??= (async () => {
      try {
        for (const stmt of schema(dialect)) await run(stmt)
      } catch (error) {
        // Concurrent isolates can race `CREATE TABLE IF NOT EXISTS` on Postgres and
        // lose with a duplicate-key error. If the table is usable, that is fine.
        try {
          await all('SELECT 1 FROM tallymark_events LIMIT 1')
        } catch {
          throw error
        }
      }
    })().catch((e) => {
      ready = null
      throw e
    })
    return ready
  }

  return {
    async insert(e) {
      await ensure()
      const head = pg ? 'INSERT INTO tallymark_events' : 'INSERT OR IGNORE INTO tallymark_events'
      const tail = pg ? ' ON CONFLICT (id) DO NOTHING' : ''
      await run(`${head} ${INSERT_COLS}${tail}`, [
        e.id,
        e.ts,
        e.type,
        e.name,
        e.visitor,
        e.hostname,
        e.path,
        e.referrer,
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
        Object.keys(e.props).length ? JSON.stringify(e.props) : null,
        e.value,
        e.duration,
        e.scroll,
      ])
    },
    async list({ from, to, limit }: ListQuery) {
      await ensure()
      // Newest-first with LIMIT keeps the most recent rows, then we restore order.
      const rows = await all<Row>(
        'SELECT * FROM tallymark_events WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?',
        [from, to, limit ?? 500_000],
      )
      return rows.reverse().map(fromRow)
    },
    async prune(before) {
      await ensure()
      if (!pg) return run('DELETE FROM tallymark_events WHERE ts < ?', [before])
      // Row counts differ across Postgres clients; counting via RETURNING works on all.
      const rows = await all<{ n: number | string }>(
        'WITH d AS (DELETE FROM tallymark_events WHERE ts < ? RETURNING 1) SELECT COUNT(*) AS n FROM d',
        [before],
      )
      return Number(rows[0]?.n ?? 0)
    },
  }
}

// ── SQL drivers: D1, bun:sqlite, libSQL, PostgreSQL ───────────────────────────

// Structural types: no runtime dependency on any database package.

/** Cloudflare D1. `d1Store(env.DB)` */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>
      all(): Promise<{ results?: unknown[] }>
    }
  }
}

export function d1Store(db: D1Like): EventStore {
  const driver: SqlDriver = {
    async run(sql, params) {
      const r = await db
        .prepare(sql)
        .bind(...params)
        .run()
      return r.meta?.changes ?? 0
    },
    async all<T>(sql: string, params: unknown[]) {
      const r = await db
        .prepare(sql)
        .bind(...params)
        .all()
      return (r.results ?? []) as T[]
    },
  }
  return sqlStore(driver)
}

/** `bun:sqlite`. `bunSqliteStore(new Database('stats.db'))` */
export interface BunSqliteLike {
  prepare(sql: string): {
    run(...params: any[]): { changes: number }
    all(...params: any[]): unknown[]
  }
}

export function bunSqliteStore(db: BunSqliteLike): EventStore {
  return sqlStore({
    async run(sql, params) {
      return db.prepare(sql).run(...(params as any[])).changes
    },
    async all<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as any[])) as T[]
    },
  })
}

/** libSQL / Turso. `libsqlStore(createClient({ url, authToken }))` */
export interface LibsqlLike {
  execute(stmt: { sql: string; args: any[] }): Promise<{ rows: unknown[]; rowsAffected: number }>
}

export function libsqlStore(client: LibsqlLike): EventStore {
  return sqlStore({
    async run(sql, params) {
      return (await client.execute({ sql, args: params as any[] })).rowsAffected
    },
    async all<T>(sql: string, params: unknown[]) {
      return (await client.execute({ sql, args: params as any[] })).rows as T[]
    },
  })
}

/**
 * PostgreSQL via anything exposing `query(text, params)`:
 * `pg` (Pool / Client), Neon (`neon(url)`), `@vercel/postgres`, Supabase (via pg),
 * PGlite, and friends.
 *
 *   pgStore(new Pool({ connectionString }))
 *   pgStore(neon(process.env.DATABASE_URL!))   // serverless HTTP driver
 */
export interface PgLike {
  query(text: string, params?: any[]): Promise<any>
}

/** `pg` returns `{ rows, rowCount }`; Neon's HTTP driver returns the rows array. */
const pgRows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows ?? []))

export function pgStore(client: PgLike): EventStore {
  return sqlStore({
    dialect: 'postgres',
    async run(sql, params) {
      const r = await client.query(sql, params)
      return Number(r?.rowCount ?? r?.affectedRows ?? 0)
    },
    async all<T>(sql: string, params: unknown[]) {
      return pgRows(await client.query(sql, params as any[])) as T[]
    },
  })
}

/** postgres.js (`postgres(url)`). */
export interface PostgresJsLike {
  unsafe(text: string, params?: any[]): PromiseLike<any>
}

export function postgresJsStore(sql: PostgresJsLike): EventStore {
  return sqlStore({
    dialect: 'postgres',
    async run(text, params) {
      const r = await sql.unsafe(text, params as any[])
      return Number(r?.count ?? 0)
    },
    async all<T>(text: string, params: unknown[]) {
      return Array.from(await sql.unsafe(text, params as any[])) as T[]
    },
  })
}

// ── Redis and Upstash ─────────────────────────────────────────────────────────

/**
 * Redis-style stores keep events in one sorted set, scored by timestamp. That is
 * exactly the access pattern analytics needs: "everything between A and B".
 */
export interface RedisLike {
  /** Add one member with a score. */
  zadd(key: string, score: number, member: string): Promise<unknown>
  /** Members with `min <= score < max` (exclusive max), newest first, at most `count`. */
  zrangeByScoreRev(key: string, min: number, max: number, count: number): Promise<unknown[]>
  /** Remove members with `score < before`. Returns the number removed. */
  zremBelow(key: string, before: number): Promise<number>
}

export function redisStore(redis: RedisLike, options: { key?: string } = {}): EventStore {
  const key = options.key ?? 'tallymark:events'
  return {
    async insert(e) {
      await redis.zadd(key, e.ts, JSON.stringify(e))
    },
    async list({ from, to, limit }: ListQuery) {
      const raw = await redis.zrangeByScoreRev(key, from, to, limit ?? 500_000)
      const out: TallymarkEvent[] = []
      for (const m of raw) {
        // Some clients (Upstash) auto-parse JSON members; others return strings.
        const e = typeof m === 'string' ? safeParse(m) : (m as TallymarkEvent)
        if (e && typeof e === 'object' && typeof e.ts === 'number') out.push(e)
      }
      return out.reverse()
    },
    prune: (before) => redis.zremBelow(key, before),
  }
}

function safeParse(s: string): TallymarkEvent | null {
  try {
    return JSON.parse(s) as TallymarkEvent
  } catch {
    return null
  }
}

/**
 * The slice of `@upstash/redis` we use: `upstashStore(Redis.fromEnv())`.
 *
 * Arguments are loose on purpose. The SDK declares many overloads that a narrower
 * structural type cannot match, which would force every user to write a cast.
 */
export interface UpstashLike {
  zadd(key: string, ...args: any[]): Promise<unknown>
  zrange(key: string, ...args: any[]): Promise<unknown>
  zremrangebyscore(key: string, ...args: any[]): Promise<unknown>
}

export function upstashStore(client: UpstashLike, options?: { key?: string }): EventStore {
  return redisStore(
    {
      zadd: (key, score, member) => client.zadd(key, { score, member }),
      // With `rev`, Upstash takes (max, min). "(" makes the upper bound exclusive.
      zrangeByScoreRev: async (key, min, max, count) =>
        ((await client.zrange(key, `(${max}`, min, {
          byScore: true,
          rev: true,
          offset: 0,
          count,
        })) as unknown[]) ?? [],
      zremBelow: async (key, before) =>
        Number(await client.zremrangebyscore(key, '-inf', `(${before}`)),
    },
    options,
  )
}

/**
 * Upstash over plain `fetch`: no SDK, works on any edge runtime.
 *   upstashRestStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
 */
export function upstashRestStore(config: {
  url: string
  token: string
  key?: string
  fetch?: typeof fetch
}): EventStore {
  const f = config.fetch ?? fetch
  const cmd = async (...args: (string | number)[]): Promise<unknown> => {
    const res = await f(config.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string }
    if (!res.ok || body.error) throw new Error(`upstash: ${body.error ?? res.status}`)
    return body.result
  }
  return redisStore(
    {
      zadd: (key, score, member) => cmd('ZADD', key, score, member),
      zrangeByScoreRev: async (key, min, max, count) =>
        ((await cmd(
          'ZRANGE',
          key,
          `(${max}`,
          min,
          'BYSCORE',
          'REV',
          'LIMIT',
          0,
          count,
        )) as unknown[]) ?? [],
      zremBelow: async (key, before) =>
        Number(await cmd('ZREMRANGEBYSCORE', key, '-inf', `(${before}`)),
    },
    { key: config.key },
  )
}

// ── Mirror (live backup) ──────────────────────────────────────────────────────

/**
 * Live backup / migration helper: every event is written to the primary store,
 * then copied to each mirror. Reads come from the primary.
 *
 *   mirrorStore(d1Store(env.DB), upstashRestStore({ ... }))   // D1 primary, Redis backup
 *
 * The primary decides success: if it fails, the insert fails. A mirror failure
 * never fails the hit; it is reported through `onError` so you can alert on it.
 * Restore from a mirror with `engine.export()` / `engine.import()`.
 */
export function mirrorStore(
  primary: EventStore,
  mirrors: EventStore | EventStore[],
  options: { onError?: (error: unknown, mirrorIndex: number) => void } = {},
): EventStore {
  const copies = Array.isArray(mirrors) ? mirrors : [mirrors]
  return {
    async insert(event: TallymarkEvent) {
      await primary.insert(event)
      const results = await Promise.allSettled(copies.map((m) => m.insert(event)))
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          try {
            options.onError?.(r.reason, i)
          } catch {
            /* a broken logger must not break the hit */
          }
        }
      })
    },
    list: (q: ListQuery) => primary.list(q),
    async prune(before) {
      const n = (await primary.prune?.(before)) ?? 0
      await Promise.allSettled(copies.map((m) => m.prune?.(before)))
      return n
    },
  }
}
