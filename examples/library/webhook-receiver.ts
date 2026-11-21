// bun examples/library/webhook-receiver.ts
//
// The other end of `forward: webhookSink(...)`: a tiny service that receives every event Tallymark
// records (Zapier, n8n, a queue, your own app) and verifies it really came from Tallymark first.
//
// Every delivery carries  x-tallymark-signature: sha256=<hex>  , an HMAC of the exact body bytes
// using the shared secret. Anyone can POST to a public URL, so never trust a delivery without it.
import { verifyWebhookSignature } from 'tallymark'

const SECRET = process.env.WEBHOOK_SECRET ?? 'whsec_demo'

Bun.serve({
  port: 4000,
  async fetch(request) {
    const body = await request.text() // verify the RAW body, not re-serialised JSON
    const valid = await verifyWebhookSignature(
      SECRET,
      body,
      request.headers.get('x-tallymark-signature'),
    )
    if (!valid) return new Response('bad signature', { status: 401 })

    const { event } = JSON.parse(body)
    console.log(`${event.type} ${event.name} ${event.path} from ${event.country ?? '?'}`)
    return new Response('ok')
  },
})

// On the Tallymark side:
//   createTallymark({ forward: webhookSink({ url: 'https://receiver.example/', secret: 'whsec_demo' }) })
