// Vercel Functions without a framework (static site, Vite, Astro, plain HTML...).
// Place in /api/analytics.ts and Vercel serves /api/analytics. The rewrite in
// ../vercel.json routes the sub-paths (/collect, /script.js, /api/...) to it too.
import { createTallymark } from 'tallymark'
import { upstashRestStore } from 'tallymark/stores'
import { vercel } from 'tallymark/vercel'

// Upstash Redis over plain fetch: no SDK, no connection pool, built for serverless.
// Add the Upstash integration in the Vercel dashboard and these variables appear.
const analytics = createTallymark({
  store: upstashRestStore({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  }),
  secret: process.env.ANALYTICS_SECRET,
  apiKey: process.env.ANALYTICS_API_KEY,
  basePath: '/api/analytics',
  allowedHosts: ['example.com'], // only record your own sites
  strictOrigin: true, // and only when the browser says the hit came from them
})

export const { GET, POST, OPTIONS } = vercel(analytics)
