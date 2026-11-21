# EXAMPLES

Every example here is commented, imports the package by its real name (`tallymark`), and says how to run it.

In your own project you install the package and the imports just work. In this repository there is nothing to install: `tsconfig.json` maps `tallymark` and `tallymark/*` to `src/` with `paths`, and **Bun** honours that mapping at runtime, so the examples run without building. `paths` only informs TypeScript and the runtime; Node does not read it. To run an example with Node, install the built package (`npm i tallymark`) instead.

Start with **events**, then pick the folder that matches your stack.

| Folder | What it shows | Verified by |
|---|---|---|
| [`events/`](./events) | **Every way to add a custom event**: HTML attributes, JavaScript, server-side, automatic outbound and download events, single-page navigation, and reading them back with a funnel, a session trace and revenue by source. | Run in a real browser (Edge), every button clicked, results read from `/stats`. |
| [`browser/`](./browser) | The smallest full loop: a page with the script tag, a server that mounts Tallymark, a `curl` to read it. | Run in a real browser. |
| [`library/`](./library) | Using it as a plain library: [`basic.ts`](./library/basic.ts) (first steps), [`reports.ts`](./library/reports.ts) (every report), [`stores.ts`](./library/stores.ts) (every storage backend), [`webhook-receiver.ts`](./library/webhook-receiver.ts) (the other end of `forward`). | `basic.ts` and `reports.ts` run; `stores.ts` type-checked against the real drivers. |
| [`frameworks/nextjs`](./frameworks/nextjs) | Next.js App Router on Vercel: the route handler, the layout component, a cron, `vercel.json`. | Route handlers called as Next.js calls them, against real PostgreSQL. |
| [`frameworks/vercel`](./frameworks/vercel) | Vercel Functions without a framework, using Upstash. | Type-checked. |
| [`frameworks/express.ts`](./frameworks/express.ts) | Express, including a server-side event from your own route. | Run, exercised with `curl`. |
| [`frameworks/hono.ts`](./frameworks/hono.ts) | Hono, including a server-side event. | Run, exercised with `curl`. |
| [`frameworks/bun.ts`](./frameworks/bun.ts), [`deno.ts`](./frameworks/deno.ts), [`cloudflare.ts`](./frameworks/cloudflare.ts) | The same handler on Bun (SQLite), Deno, and Cloudflare Workers (D1). | Bun and Cloudflare type-checked; Deno is a short snippet, not executed. |
| [`frameworks/sveltekit`](./frameworks/sveltekit), [`astro`](./frameworks/astro), [`react`](./frameworks/react) | One file each for SvelteKit and Astro, and a React app. | Type-checked. SvelteKit and Astro use the same `Request` to `Response` contract as the others; they were not run inside those frameworks. |
| [`http/`](./http) | Sending events and reading stats from **curl, Python, Go, PHP, Ruby and Java**, using only each language's standard library. | Every file run in its official Docker image against a live server. |

## Running them

```bash
bun examples/library/basic.ts
bun examples/events/server.ts            # then open http://localhost:3000
bun examples/frameworks/express.ts
```

For the language examples, start a server that trusts forwarded headers and run any file with your API key:

```bash
TALLYMARK_SECRET=x TALLYMARK_API_KEY=k TALLYMARK_TRUST_PROXY=true TALLYMARK_DB=:memory: bun src/cli.ts &
TALLYMARK_API_KEY=k python3 examples/http/python.py
```

## What you do not have to write

Several examples feed made-up traffic into the library so they can run on their own. In a real project you write none of that. Add the script tag and Tallymark records pageviews, sources, devices, locations, time on page and scroll depth by itself. What you add are the **custom events** that matter to you, shown in [`events/`](./events).
