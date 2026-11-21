import type { TallymarkEvent } from './types.js'

export interface WebhookOptions {
  url: string
  /**
   * If set, each request carries `x-tallymark-signature: sha256=<hex>`, an
   * HMAC-SHA256 of the raw body. Verify it before trusting a delivery.
   */
  secret?: string
  headers?: Record<string, string>
  /** Per-attempt timeout. Default 5000 ms. */
  timeoutMs?: number
  /** Extra attempts after the first on network errors / 5xx. Default 1. */
  retries?: number
  fetch?: typeof fetch
}

const enc = new TextEncoder()

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Third-party fan-out: POST every event as JSON to any URL (Zapier, n8n, Slack
 * relay, your own queue). Use as `forward`:
 *
 *   createTallymark({ forward: webhookSink({ url, secret }) })
 *
 * Throws on final failure, which the engine routes to `onError`; it never fails
 * the visitor's hit.
 */
export function webhookSink(options: WebhookOptions): (event: TallymarkEvent) => Promise<void> {
  const f = options.fetch ?? fetch
  const attempts = 1 + Math.max(0, options.retries ?? 1)
  return async (event) => {
    const body = JSON.stringify({ type: 'tallymark.event', event })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...options.headers,
    }
    if (options.secret)
      headers['x-tallymark-signature'] = `sha256=${await hmacHex(options.secret, body)}`

    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await f(options.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        })
        if (res.ok) return
        lastError = new Error(`webhook responded ${res.status}`)
        if (res.status < 500) break // 4xx will not get better on retry
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
}

/** Verify a delivery on the receiving end. Constant-time. */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  const expected = await hmacHex(secret, rawBody)
  const got = header.slice(7)
  if (got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i)
  return diff === 0
}
