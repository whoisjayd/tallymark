// Daily retention sweep. Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`
// (set CRON_SECRET in the project settings). See ../../../vercel.json for the schedule.
import { vercelCron } from 'tallymark/vercel'
import { analytics } from '../../../lib/analytics'

export const GET = vercelCron(analytics, { secret: process.env.CRON_SECRET })
