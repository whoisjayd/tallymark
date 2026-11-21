// Retention sweep for the function in ./analytics.ts. Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`; set CRON_SECRET in the project settings.
import { createTallymark } from 'tallymark'
import { vercelCron } from 'tallymark/vercel'

// In a real project, import the same instance from a shared module instead.
const analytics = createTallymark({ retentionDays: 395 })

export const GET = vercelCron(analytics, { secret: process.env.CRON_SECRET })
