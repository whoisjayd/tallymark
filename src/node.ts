import type { Tallymark } from './tallymark.js'
import type { ConnInfo } from './types.js'

/**
 * Node.js `http` / Express / Fastify / Connect. Structural types only, so this
 * file imports nothing from Node and stays runtime-neutral.
 *
 *   import express from 'express'
 *   app.use('/analytics', nodeHandler(analytics))           // express
 *   http.createServer(nodeHandler(analytics)).listen(3000)  // plain node
 *
 * Mount under a prefix and set `basePath` to match, e.g. `basePath: '/analytics'`.
 */
export interface NodeRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string
  url?: string
  originalUrl?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string; encrypted?: boolean }
}

export interface NodeResponseLike {
  statusCode: number
  setHeader(name: string, value: string | string[]): unknown
  end(chunk?: Uint8Array | string): unknown
}

/**
 * A Fetch `Request` built from a Node request. Pass a body only when you need one:
 * without it the body stream is never touched, so this is safe after `express.json()`.
 * Use it with `tm.trackRequest(nodeRequest(req), ...)` to record server-side events.
 */
export function nodeRequest(req: NodeRequestLike, body?: Uint8Array): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const x of v) headers.append(k, x)
    else headers.set(k, v)
  }
  const host = headers.get('host') ?? 'localhost'
  const proto =
    req.socket?.encrypted || headers.get('x-forwarded-proto') === 'https' ? 'https' : 'http'
  // Express strips the mount prefix from `url`; `originalUrl` keeps it.
  const url = new URL(req.originalUrl ?? req.url ?? '/', `${proto}://${host}`)
  return new Request(url, {
    method: (req.method ?? 'GET').toUpperCase(),
    headers,
    body: body as unknown as BodyInit | undefined,
  })
}

/** The socket address is the truth unless a proxy you control sits in front. */
export function nodeConn(req: NodeRequestLike, options: { trustProxy?: boolean } = {}): ConnInfo {
  return { ip: options.trustProxy ? undefined : req.socket?.remoteAddress }
}

export function nodeHandler(engine: Tallymark, options: { trustProxy?: boolean } = {}) {
  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase()
    let body: Uint8Array | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const parts: Uint8Array[] = []
      for await (const chunk of req)
        parts.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
      let off = 0
      for (const p of parts) {
        body.set(p, off)
        off += p.byteLength
      }
    }

    const response = await engine.handle(nodeRequest(req, body), nodeConn(req, options))

    res.statusCode = response.status
    response.headers.forEach((value, key) => {
      res.setHeader(key, value)
    })
    res.end(new Uint8Array(await response.arrayBuffer()))
  }
}
