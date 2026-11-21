import { timezone } from './hit.js'
import { createTallymark, type Tallymark } from './tallymark.js'
import type { TallymarkOptions } from './types.js'

/**
 * Cloudflare Workers. Bindings only exist per request, so the engine is built
 * lazily from `env` and reused for the life of the isolate.
 *
 *   export default cloudflare<Env>((env) => ({
 *     store: d1Store(env.DB),
 *     secret: env.SECRET,
 *     apiKey: env.API_KEY,
 *   }))
 *
 * Add `[triggers] crons = ["0 3 * * *"]` to wrangler.toml and `retentionDays`
 * to enforce data retention.
 */
/**
 * Cloudflare exposes precise location on `request.cf`, not in headers. Only the
 * country header is sent by default, so read the object for region and city.
 * `XX` (unknown) and `T1` (Tor) are not countries.
 */
function cfGeo(request: Request) {
  const cf = (
    request as { cf?: { country?: string; region?: string; city?: string; timezone?: string } }
  ).cf
  if (!cf) return undefined
  const country =
    cf.country &&
    /^[A-Za-z]{2}$/.test(cf.country) &&
    !['XX', 'T1'].includes(cf.country.toUpperCase())
      ? cf.country.toUpperCase()
      : null
  return {
    country,
    region: cf.region ?? null,
    city: cf.city ?? null,
    timezone: timezone(cf.timezone),
  }
}

export function cloudflare<Env>(config: (env: Env) => TallymarkOptions) {
  let engine: Tallymark | undefined
  const get = (env: Env) => (engine ??= createTallymark(config(env)))
  return {
    fetch: (request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }) =>
      get(env).handle(request, {
        waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,
        geo: cfGeo(request),
      }),
    scheduled: async (
      _event: unknown,
      env: Env,
      ctx?: { waitUntil(p: Promise<unknown>): void },
    ) => {
      const job = get(env).prune()
      if (ctx) ctx.waitUntil(job)
      else await job
    },
  }
}
