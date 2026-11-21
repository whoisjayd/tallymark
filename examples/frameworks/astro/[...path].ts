// Astro: src/pages/analytics/[...path].ts
//
// Needs server rendering (an SSR adapter, output "server" or "hybrid"). The endpoint serves the browser
// script, receives its hits and answers the reports, all through one Fetch handler.
import { createTallymark } from 'tallymark'

const analytics = createTallymark({
  secret: process.env.ANALYTICS_SECRET,
  apiKey: process.env.ANALYTICS_API_KEY,
  basePath: '/analytics',
})

export const prerender = false

export const ALL = ({ request }: { request: Request }) => analytics.handle(request)

// Load the tracker once, in your layout. One tag records pageviews, sources, devices, time on page and
// scroll depth. `is:inline` stops Astro from bundling it, so it keeps reading its own data-* settings:
//   <script is:inline defer src="/analytics/script.js"></script>
//
// A custom event needs no code: <button data-tally="Signup" data-tally-plan="pro">
