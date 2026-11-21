// SvelteKit: src/routes/analytics/[...path]/+server.ts
//
// SvelteKit endpoints are Fetch handlers, so Tallymark plugs straight in. The one file below serves
//   /analytics/script.js   the browser script
//   /analytics/collect     the hits it sends
//   /analytics/api/*       reports (needs the API key)
// Every verb goes to the same handler. No framework types are needed.
import { createTallymark } from 'tallymark'

const analytics = createTallymark({
  secret: process.env.ANALYTICS_SECRET,
  apiKey: process.env.ANALYTICS_API_KEY,
  basePath: '/analytics',
})

const handler = ({ request }: { request: Request }) => analytics.handle(request)

export { handler as GET, handler as POST, handler as OPTIONS }

// Load the tracker once, in src/app.html or +layout.svelte. That single tag records pageviews
// (including SvelteKit's client-side navigation), sources, devices, time on page and scroll depth:
//   <script defer src="/analytics/script.js"></script>
//
// A custom event needs no code either: <button data-tally="Signup" data-tally-plan="pro">
// Or from a +page.server.ts action, record one on the server:
//   await analytics.trackRequest(request, { name: 'Signup', props: { plan: 'pro' } })
