// Mounts the whole Tallymark API (collect, script.js, stats) at /api/analytics/*.
// In a real project, import waitUntil from '@vercel/functions' so forwarding and
// mirroring run after the response is sent: vercel(analytics, { waitUntil }).
import { vercel } from 'tallymark/vercel'
import { analytics } from '../../../../lib/analytics'

export const { GET, POST, OPTIONS } = vercel(analytics)
