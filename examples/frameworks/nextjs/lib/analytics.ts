// One Tallymark instance for the whole Next.js app. Import it wherever you need it.

import { Pool } from 'pg' // Neon, Supabase, Vercel Postgres and RDS all work. Or use neon(url) for HTTP.
import { createTallymark } from 'tallymark'
import { pgStore } from 'tallymark/stores'

export const analytics = createTallymark({
  store: pgStore(new Pool({ connectionString: process.env.DATABASE_URL })),
  secret: process.env.ANALYTICS_SECRET, // salts the daily visitor hash
  apiKey: process.env.ANALYTICS_API_KEY, // read API is off without it
  basePath: '/api/analytics', // where the route handler below is mounted
  retentionDays: 395,
  onError: (error, { where }) => console.error('[tallymark]', where, error),
})
