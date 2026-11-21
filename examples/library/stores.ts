// Every storage backend, in one place. Pick ONE; they are interchangeable, and you can switch later
// (export from the old one, import into the new one). Tallymark creates its table or key on first use.
//
// How to choose:
//   • just trying it / tests ........ memoryStore
//   • one server, want it simple .... bunSqliteStore
//   • you already run Postgres ...... pgStore   (Supabase, Neon, RDS, anything)
//   • Cloudflare Workers ............ d1Store
//   • Vercel / other serverless ..... pgStore with Neon, upstashRestStore, or libsqlStore (Turso)
//
// This file only builds the stores (it does not connect), so it runs without any services.
import { Database } from 'bun:sqlite'
import { Redis } from '@upstash/redis'
import { Pool } from 'pg'
import { createTallymark } from 'tallymark'
import {
  bunSqliteStore,
  memoryStore,
  mirrorStore,
  pgStore,
  upstashRestStore,
  upstashStore,
} from 'tallymark/stores'

// Nothing to set up. Lost on restart. The default.
export const inMemory = memoryStore({ maxEvents: 50_000 })

// A file. Great for one server.
export const sqlite = bunSqliteStore(new Database('stats.db', { create: true }))

// PostgreSQL: Supabase, Neon, RDS, self-hosted. Any client with query(text, params) works.
export const postgres = pgStore(new Pool({ connectionString: process.env.DATABASE_URL }))
//   Neon over HTTP (serverless):   pgStore(neon(process.env.DATABASE_URL))     // from @neondatabase/serverless
//   Vercel Postgres:               pgStore(sql)                                // from @vercel/postgres
//   postgres.js:                   postgresJsStore(postgres(url))
//   Bun's built-in client:         postgresJsStore(new SQL(url))               // import { SQL } from 'bun'

// Upstash Redis, over plain fetch (no SDK) or with the official client.
export const upstash = upstashRestStore({
  url: process.env.UPSTASH_REDIS_REST_URL ?? '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
})
export const upstashSdk = upstashStore(Redis.fromEnv())

// Cloudflare D1:   d1Store(env.DB)            // inside a Worker, see ../frameworks/cloudflare.ts
// Turso / libSQL:  libsqlStore(createClient({ url, authToken }))

// A live backup or a migration: every event goes to the primary and is copied to the mirrors.
// If a mirror fails the hit still succeeds, and onError tells you.
export const withBackup = mirrorStore(sqlite, [inMemory], {
  onError: (error, i) => console.error(`mirror ${i} failed`, error),
})

// Your own store is three methods:
//   { insert(event), list({ from, to, limit }), prune?(before) }

export const analytics = createTallymark({ store: withBackup, secret: 'change-me' })
