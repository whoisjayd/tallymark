// bun examples/events/server.ts  →  open http://localhost:3000, click around, then open /stats
//
// Custom events, end to end: how they are sent (index.html and this file) and how to read them back.
import { createTallymark } from 'tallymark'

const tm = createTallymark({
  secret: 'dev-secret',
  apiKey: 'dev-key',
  basePath: '/analytics', // the browser script and the API live under /analytics
})

// ── Sending events from the server ───────────────────────────────────────────
//
// Use these for things that never happen in a browser: a payment provider's webhook, a cron job,
// a mobile app calling your API. There are two functions, and you almost always want the first.

/**
 * trackRequest: you already have the visitor's request in hand (a route handler, a server action).
 * It reads their IP, browser, language, location and referrer from it, so you only say what happened.
 */
async function subscribe(request: Request, conn: { ip?: string }) {
  const { plan } = (await request.json().catch(() => ({}))) as { plan?: string }

  const result = await tm.trackRequest(
    request,
    {
      name: 'Subscribe', //          what happened
      props: { plan: plan ?? 'free' }, // facts to break it down by (flat; strings, numbers, booleans)
      value: 5, //                   a number to sum, e.g. what this is worth
    },
    conn,
  ) // conn = the socket address; behind Vercel/Cloudflare you can omit it

  // trackRequest never throws. It returns what happened, so you can tell why a hit was skipped:
  //   { ok: true, event }   recorded
  //   { ok: false, reason } 'bot' | 'dnt' | 'excluded' | 'spam' | 'host' | 'invalid' | 'storage' ...
  return Response.json({ ok: result.ok })
}

/**
 * track: there is no visitor request, only facts you already know (a webhook from a payment
 * provider). You supply what is available; everything is optional except the url.
 */
async function paymentWebhook() {
  await tm.track({
    name: 'Purchase',
    url: 'https://shop.example/checkout/success', // the page this belongs to
    props: { sku: 'A1', method: 'card' },
    value: 49,
    country: 'DE', //  you may know the country from the billing address
    // ip / userAgent are optional: without them the hit counts as its own anonymous visitor.
  })
}
void paymentWebhook // shown for illustration; call it from your webhook route

// ── Reading events back ──────────────────────────────────────────────────────

async function stats() {
  return {
    // Every event name, how many times, how many people, and the summed value (revenue).
    events: await tm.top('event', '24h'),

    // Break one event down by a property you attached: prop:<name>.
    //   → [{ key: 'pro', count: 2, value: 98 }, { key: 'free', count: 1, value: 0 }]
    signupsByPlan: await tm.top('prop:plan', '24h', { event: 'Signup' }),

    // The other direction: filter to one property value, then ask about the events.
    proSignups: await tm.top('event', '24h', { 'prop:plan': 'pro' }),

    // Who converts? Ordered steps of pages and events. Here: saw pricing, then signed up.
    funnel: await tm.funnel([{ path: '/' }, { event: 'Signup' }], '24h'),

    // Which source earns money? Events inherit the visitor's source (Google, a newsletter, ...).
    purchasesByChannel: await Promise.all(
      ['Organic Search', 'Social', 'Email', 'Direct'].map(async (channel) => ({
        channel,
        purchases: await tm.top('event', '24h', { channel, event: 'Purchase' }),
      })),
    ),

    // The path one visitor took, step by step, with the events they fired along the way.
    latestSession: (await tm.sessions('24h', {}, 1))[0],
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(request, server) {
    const { pathname } = new URL(request.url)
    const conn = { ip: server.requestIP(request)?.address }

    if (pathname.startsWith('/analytics')) return tm.handle(request, conn)
    if (pathname === '/api/subscribe' && request.method === 'POST') return subscribe(request, conn)
    if (pathname === '/stats') return Response.json(await stats())
    return new Response(Bun.file(`${import.meta.dir}/index.html`))
  },
})

console.log('open http://localhost:3000')
