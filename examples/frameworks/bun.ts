// bun examples/frameworks/bun.ts
//
// The smallest complete server: Tallymark with data that survives restarts (a SQLite file).
// Point any site's <script src="http://localhost:3000/script.js"> at it and it starts counting.
// (The packaged CLI does the same with zero code: `bunx tallymark`.)
import { Database } from 'bun:sqlite'
import { createTallymark } from 'tallymark'
import { bunSqliteStore } from 'tallymark/stores'

const analytics = createTallymark({
  // A file on disk. The table is created on first use; reads and writes need no setup.
  store: bunSqliteStore(new Database('stats.db', { create: true })),

  secret: process.env.TALLYMARK_SECRET ?? 'change-me', // set a real one in production
  apiKey: process.env.TALLYMARK_API_KEY ?? 'dev-key', //  protects /api/*
})

Bun.serve({
  port: 3000,
  // Tell Tallymark the real socket address. Nothing sits in front of this server, so it is
  // the only trustworthy source for the visitor's IP (headers could be forged by anyone).
  fetch: (req, server) => analytics.handle(req, { ip: server.requestIP(req)?.address }),
})
