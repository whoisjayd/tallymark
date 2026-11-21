// deno run --allow-net --allow-env examples/frameworks/deno.ts
//
// Deno and Deno Deploy: the handler is a plain Fetch function, so it needs no adapter.
import { createTallymark } from 'npm:tallymark'

// Deno's global, declared so this file also reads cleanly outside Deno.
declare const Deno: {
  env: { get(key: string): string | undefined }
  serve(
    options: { port: number },
    handler: (
      request: Request,
      info: { remoteAddr: { hostname: string } },
    ) => Response | Promise<Response>,
  ): unknown
}

const analytics = createTallymark({
  secret: Deno.env.get('TALLYMARK_SECRET'), // salts the anonymous visitor hash
  apiKey: Deno.env.get('TALLYMARK_API_KEY'), // protects /api/*; without it the read API is off
})

Deno.serve({ port: 3000 }, (request, info) =>
  // info.remoteAddr is the real socket address: the trustworthy source for the visitor's IP.
  analytics.handle(request, { ip: info.remoteAddr.hostname }),
)
