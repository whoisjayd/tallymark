// A complete Cloudflare Worker. Deploy with `wrangler deploy`.
//
// What you get with no extra configuration:
//   • the visitor's country, region, city and timezone (read from Cloudflare's own request data)
//   • their real IP (hashed, never stored)
//   • work that runs after the response (forwarding to webhooks) without slowing the visitor down
//
//   wrangler.toml
//     name = "stats"
//     main = "examples/frameworks/cloudflare.ts"
//     compatibility_date = "2026-01-01"
//     [[d1_databases]]                      # a serverless SQLite database
//     binding = "DB"                        # becomes env.DB below
//     database_name = "stats"
//     database_id = "<from `wrangler d1 create stats`>"
//     [triggers]
//     crons = ["0 3 * * *"]                 # runs `scheduled` below every day at 03:00: the retention sweep
//
//   Secrets (never commit these):  wrangler secret put SECRET && wrangler secret put API_KEY
import { cloudflare } from 'tallymark/cloudflare'
import { d1Store } from 'tallymark/stores'

interface Env {
  DB: Parameters<typeof d1Store>[0]
  SECRET: string
  API_KEY: string
}

// Bindings only exist per request on Workers, so the config is a function of `env`.
// It runs once per isolate and the result is reused.
export default cloudflare<Env>((env) => ({
  store: d1Store(env.DB),
  secret: env.SECRET,
  apiKey: env.API_KEY,
  retentionDays: 395, // events older than this are deleted by the daily cron
  onError: (error, { where }) => console.error(where, error), // shows up in `wrangler tail`
}))
