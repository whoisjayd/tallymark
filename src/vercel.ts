import { timingSafeEqual } from './http.js'
import type { Tallymark } from './tallymark.js'

/**
 * Vercel Functions and Next.js route handlers (anything that takes a Web `Request`).
 * Vercel sets `x-real-ip` and `x-vercel-ip-*` headers, which Tallymark reads for the
 * visitor's IP, country, region, city and timezone.
 *
 *   // app/api/analytics/[...route]/route.ts
 *   import { waitUntil } from '@vercel/functions'
 *   export const { GET, POST, OPTIONS } = vercel(analytics, { waitUntil })
 *
 * Set `basePath: '/api/analytics'` on the instance so routes resolve under that path.
 * `waitUntil` is optional: with it, `forward` runs after the response is sent. `mirrorStore` copies are awaited before the response.
 */
export function vercel(
  tm: Tallymark,
  options: { waitUntil?: (promise: Promise<unknown>) => void } = {},
) {
  const handler = (request: Request) => tm.handle(request, { waitUntil: options.waitUntil })
  return { GET: handler, POST: handler, OPTIONS: handler }
}

/**
 * Retention sweep for a Vercel Cron Job. Vercel sends `Authorization: Bearer $CRON_SECRET`;
 * without a secret configured, the handler refuses every call.
 *
 *   // app/api/analytics-cron/route.ts
 *   export const GET = vercelCron(analytics, { secret: process.env.CRON_SECRET })
 *
 *   // vercel.json
 *   { "crons": [{ "path": "/api/analytics-cron", "schedule": "0 3 * * *" }] }
 */
export function vercelCron(tm: Tallymark, options: { secret: string | undefined }) {
  return async (request: Request): Promise<Response> => {
    const token = (request.headers.get('authorization') ?? '').replace(/^bearer /i, '')
    if (!options.secret || !timingSafeEqual(token, options.secret)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    }
    return Response.json({ ok: true, pruned: await tm.prune() })
  }
}
