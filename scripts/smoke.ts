export {}

/**
 * Post-build smoke test: uses the BUILT package the way a consumer would, so a
 * broken build, missing export, bad bin, or oversized tracker fails before publish.
 */
const { createTallymark } = await import('../dist/index.js')
const stores = await import('../dist/stores.js')
const cf = await import('../dist/cloudflare.js')
const node = await import('../dist/node.js')
const react = await import('../dist/react.js')
const vercel = await import('../dist/vercel.js')

const exports: Record<string, unknown> = {
  createTallymark,
  memoryStore: stores.memoryStore,
  pgStore: stores.pgStore,
  upstashRestStore: stores.upstashRestStore,
  cloudflare: cf.cloudflare,
  nodeHandler: node.nodeHandler,
  Analytics: react.Analytics,
  vercel: vercel.vercel,
  vercelCron: vercel.vercelCron,
}
for (const [name, v] of Object.entries(exports)) {
  if (typeof v !== 'function') throw new Error(`missing export: ${name}`)
}

const tm = createTallymark({ secret: 's' })
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
const r = await tm.track({ url: 'https://example.com/', ip: '1.1.1.1', userAgent: UA })
if (!r.ok) throw new Error('track failed')
if ((await tm.summary('24h')).pageviews !== 1) throw new Error('summary wrong')

const script = await (await tm.handle(new Request('http://x/script.js'))).text()
if (script.length > 6144) throw new Error(`tracker too large: ${script.length} bytes (budget 6144)`)

// The published bin must start and answer.
const port = 30_000 + Math.floor(Math.random() * 10_000)
const proc = Bun.spawn(['bun', 'dist/cli.js'], {
  env: { ...process.env, PORT: String(port), TALLYMARK_DB: ':memory:' },
  stdout: 'ignore',
  stderr: 'ignore',
})
try {
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/health`).then(
      (x) => x.ok,
      () => false,
    )
    if (!up) await Bun.sleep(50)
  }
  if (!up) throw new Error('dist/cli.js did not start')
} finally {
  proc.kill()
}

console.log(`smoke ok · tracker ${script.length} B`)
