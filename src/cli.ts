#!/usr/bin/env bun
/**
 * Self-host in one command:
 *
 *   TALLYMARK_SECRET=... TALLYMARK_API_KEY=... bunx tallymark
 *
 * Storage (first match wins):
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   Upstash Redis
 *   TALLYMARK_DB=postgres://user:pass@host/db           PostgreSQL (Bun's built-in client)
 *   TALLYMARK_DB=./tallymark.db                        SQLite file (default)
 *   TALLYMARK_DB=:memory:                               in-memory, lost on restart
 *
 * Other env:
 *   PORT (3000) · TALLYMARK_SECRET · TALLYMARK_API_KEY
 *   TALLYMARK_ORIGINS, TALLYMARK_HOSTS, TALLYMARK_EXCLUDE_IPS, TALLYMARK_BLOCKED_REFERRERS (comma lists)
 *   TALLYMARK_STRICT_ORIGIN=true · TALLYMARK_RETENTION_DAYS · TALLYMARK_TRUST_PROXY=true
 *   TALLYMARK_WEBHOOK_URL + TALLYMARK_WEBHOOK_SECRET   forward every event to a third party
 */
import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { bunSqliteStore, memoryStore, postgresJsStore, upstashRestStore } from './stores.js'
import { createTallymark } from './tallymark.js'
import type { EventStore } from './types.js'
import { webhookSink } from './webhook.js'

const env = process.env
const fail = (msg: string): never => {
  console.error(`tallymark: ${msg}`)
  process.exit(1)
}
const list = (v?: string) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined
const int = (name: string, fallback: number): number => {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0
    ? n
    : fail(`${name} must be a non-negative integer, got "${raw}"`)
}

if (!env.TALLYMARK_SECRET) {
  console.warn(
    '! TALLYMARK_SECRET is not set: visitor ids will reset on every restart. Try: openssl rand -hex 32',
  )
}
if (!env.TALLYMARK_API_KEY) {
  console.warn('! TALLYMARK_API_KEY is not set: the read API is disabled.')
}

// ── storage ──────────────────────────────────────────────────────────────
let store: EventStore
let closeStore: () => void = () => {}
let where: string

const db = env.TALLYMARK_DB ?? './tallymark.db'
if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  store = upstashRestStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
  where = 'upstash'
} else if (/^postgres(ql)?:\/\//i.test(db)) {
  const pg = new SQL(db)
  store = postgresJsStore(pg)
  closeStore = () => void pg.close()
  where = 'postgres'
} else if (db === ':memory:') {
  store = memoryStore()
  where = 'memory (data is lost on restart)'
} else {
  const sqlite = new Database(db, { create: true })
  // WAL: readers don't block the writer. busy_timeout: wait instead of erroring under contention.
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA busy_timeout = 5000')
  store = bunSqliteStore(sqlite)
  closeStore = () => sqlite.close()
  where = `sqlite ${db}`
}

// ── engine ───────────────────────────────────────────────────────────────
const trustProxy = env.TALLYMARK_TRUST_PROXY === 'true'

const analytics = createTallymark({
  store,
  secret: env.TALLYMARK_SECRET,
  apiKey: env.TALLYMARK_API_KEY,
  allowedOrigins: list(env.TALLYMARK_ORIGINS) ?? '*',
  allowedHosts: list(env.TALLYMARK_HOSTS),
  excludeIps: list(env.TALLYMARK_EXCLUDE_IPS),
  blockedReferrers: list(env.TALLYMARK_BLOCKED_REFERRERS),
  strictOrigin: env.TALLYMARK_STRICT_ORIGIN === 'true',
  retentionDays: int('TALLYMARK_RETENTION_DAYS', 0),
  // Behind nginx / Caddy / Cloudflare? Set TALLYMARK_TRUST_PROXY=true.
  trustProxy,
  forward: env.TALLYMARK_WEBHOOK_URL
    ? webhookSink({ url: env.TALLYMARK_WEBHOOK_URL, secret: env.TALLYMARK_WEBHOOK_SECRET })
    : undefined,
  onError: (error, { where }) =>
    console.error(`tallymark: ${where} failed:`, (error as Error)?.message ?? error),
})

if (env.TALLYMARK_STRICT_ORIGIN === 'true' && !env.TALLYMARK_HOSTS) {
  fail('TALLYMARK_STRICT_ORIGIN=true requires TALLYMARK_HOSTS')
}

// Direct exposure: the socket address is the truth. Behind a proxy it is the proxy's
// address, so defer to the forwarded headers instead.
const server = Bun.serve({
  port: int('PORT', 3000),
  fetch: (req, srv) =>
    analytics.handle(req, { ip: trustProxy ? undefined : srv.requestIP(req)?.address }),
})
console.log(`tallymark listening on ${server.url} · storage: ${where}`)

// Retention: once at boot, then daily.
if (analytics.options.retentionDays) {
  const sweep = () => analytics.prune().catch(() => undefined)
  void sweep()
  setInterval(sweep, 86_400_000).unref()
}

// Graceful shutdown: finish in-flight requests, then release the database.
let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  await server.stop()
  closeStore()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
