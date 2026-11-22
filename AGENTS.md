# AGENTS.md

Guidance for AI coding agents and humans working on **tallymark**: a cookieless analytics library, a Fetch-standard HTTP API, and a browser script. License: AGPL-3.0-only. ESM only.

Integrating tallymark into someone else's project? Read [llms.txt](./llms.txt) instead. This file is for changing tallymark itself.

## Commands

```bash
bun install            # dependencies and git hooks
bun run check          # format, lint, typecheck, tests. Run before a pull request.
bun run format         # rewrite the tree to the Biome style
bun test               # tests only (bun:test)
bun run services       # start real Postgres, Redis and an Upstash-compatible proxy in Docker
bun run test:services  # the store contract suite against those real services
bun run build          # tsc -> dist/ (JS + .d.ts)
bun run smoke          # imports the BUILT package like a consumer; checks exports, the bin, tracker size
bun run validate       # publint + are-the-types-wrong against the packed tarball
bun run dev            # run the self-host server with --watch
```

A change is done when `check`, `build`, `smoke` and `validate` pass. CI runs that, plus the store suite against real services and a Docker image, when the diff touches code. A documentation-only change still reports the `ci` check and skips those jobs. Require that `ci` check on `main`.

## Layout

One flat folder, one idea per file. The tracker is a hand-written string, so it needs no build step.

```
src/index.ts        public exports for `tallymark`
src/types.ts        every public type. Add new public types here.
src/tallymark.ts    createTallymark(): track, trackRequest, queries, export/import, prune
src/query.ts        PURE aggregation over events: dimensions, sessions, time on page, funnel, journeys
src/hit.ts          turning a request into clean fields: User-Agent, URL, geo, language, spam, visitor hash
src/http.ts         the Request -> Response handler: routing, auth, CORS, validation, rate limit
src/script.ts       the browser script, as a hand-written string served at /script.js
src/stores.ts       every EventStore: memory, SQL (SQLite + PostgreSQL), Redis/Upstash, mirror, drivers
src/webhook.ts      webhookSink and signature verification
src/react.tsx       <Analytics /> and track()
src/cloudflare.ts   Cloudflare Workers adapter
src/vercel.ts       Vercel adapter and cron handler
src/node.ts         Node / Express adapter
src/cli.ts          `bunx tallymark`. The only file allowed to import `bun` or `bun:*`.
test/               bun:test. stores.test.ts is the contract every store must pass.
examples/           runnable, commented, type-checked
docs/               HOW_IT_WORKS.md, USAGE.md, DEPLOYMENT.md
llms.txt            integration guide for AI agents; ships in the package
```

Reads: `handler -> tallymark.ts -> store.list() -> query.ts`. Writes: `handler or trackRequest -> tallymark.track() -> store.insert()`.

## Rules that must not be broken

1. **Zero runtime dependencies.** Web-standard APIs only (`fetch`, `Request`, `Response`, `crypto.subtle`, `URL`). Never add to `dependencies`. Database clients are structural types (`D1Like`, `PgLike`, `LibsqlLike`, `UpstashLike`), never imports. `react` is an optional peer, imported only in `src/react.tsx`.
2. **Runtime-neutral core.** Only `cli.ts` may import `node:*`, `bun` or `bun:*`. The rest must run on Workers, Vercel Edge, Deno and Bun.
3. **Explicit `.js` on every relative import** (`from './types.js'`). Without it the emitted `.d.ts` files break under Node16/NodeNext. `bun run validate` catches it.
4. **Privacy invariants.** Never store a raw IP, a raw User-Agent, a full query string, or any identifier that survives the UTC day. Only `utm_*`, `ref` and `source` query parameters are kept. Raw screen width is bucketed, never stored. Anything that weakens this needs a discussion first.
5. **The database stays optional.** The default store is `memoryStore()`. Core features must work with it.
6. **Safe defaults.** The read API is off without `apiKey`. Bad input is a typed result or a 4xx, never a 500 or a throw. Ignored hits answer 202 so callers learn nothing.
7. **Never leak internals.** The handler's catch-all answers `{ error: 'internal' }`; details go to `onError`. A throwing `onError` or `forward` must never break a hit.
8. **One schema definition.** An event field lives in these places and they must agree: the type in `types.ts`, the column in `COLUMNS`, `COLS`, `Row`, `fromRow` and the `insert()` parameters in `stores.ts`, the CSV columns in `query.ts`, and the check in `isTallymarkEvent`.
9. **Parameterised SQL only.** Values go through `?` placeholders. Column and table names are constants.
10. **Types are the contract.** Keep `strict` and `noUncheckedIndexedAccess` green. Public structural types must accept the official client (a test passes `new Redis()` and `new Pool()` without a cast).
11. **The tracker is one hand-written string** in `script.ts`, ES2017, no build. Budget 6 KB (enforced by tests and `smoke`). It sets no cookies and writes no storage.
12. **Docs match the code.** Changing an option, method, dimension or endpoint means updating `docs/USAGE.md`, `llms.txt` and the README in the same change.

## Conventions

- TypeScript, no semicolons, single quotes, 2-space indent, trailing commas. Biome enforces this (`biome.json`); do not hand-format.
- Small pure functions; I/O at the edges (`stores.ts`, `http.ts`).
- Comments explain why, not what. Examples are the exception: they are teaching material and should be generously commented.
- No new abstraction until the third use. Prefer a deep module to many tiny files.
- Expected failures return `{ ok: false, reason }`; throw only for programmer errors.
- Documentation file names are uppercase (`README.md`, `USAGE.md`). There is no changelog; releases use GitHub's generated notes.

## Commits

Conventional Commits, one logical change per commit, and each commit is a single line.

```
<type>: <what changed, lowercase, imperative, no trailing period>
```

- **One line only.** No body, no footer, no trailers. No `Co-Authored-By`, no sign-offs, no tool or AI attribution. The commit-msg hook rejects anything else. `Merge` and `Revert` lines are the exception git writes itself, and so are Dependabot's own commits: GitHub writes their body and trailers, and the hook runs only on local commits.
- **Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
- **Subject:** at most 72 characters, describing the change, not the file.
- **Atomic means grouped, not tiny.** A commit holds every file that belongs to one logical change: a feature with its tests and docs, a set of related guides, a group of adapters. Never one file per commit, and never unrelated changes together. A fix and its regression test go in the same commit, and the tests pass at every commit.

Examples: `feat: add week and month buckets to timeseries`, `fix: count a visit from search as one session`, `docs: explain how the visitor hash works`.

## Adding things

- **A dimension:** add it to `StaticDimension` (`types.ts`), `DIMENSIONS` and `dimensionValue()` (`query.ts`); if it needs a new stored field, follow rule 8. Update `docs/USAGE.md`, `llms.txt`, and add it to the table in `test/analytics.test.ts`.
- **A store:** implement `EventStore` (or provide a `SqlDriver` or `RedisLike`). Export it from `stores.ts`. **Add it to the factory list in `test/stores.test.ts`**: that contract suite is what proves it correct.
- **An endpoint:** the route in `http.ts`, the logic in `tallymark.ts` or `query.ts`, then docs, `llms.txt` and a test through `tm.handle(new Request(...))`.
- **An adapter:** a thin wrapper over `tm.handle`; add it to `package.json` exports and to `scripts/smoke.ts`.
- **An example:** it must import `tallymark` by name, be commented, run or at least type-check, and be listed in `examples/README.md` with how it is verified.

## Testing

- Drive the engine with an injected clock (`now`). A range ends at `now`, so advance the clock past your last event before you query.
- Test HTTP through `tm.handle(new Request(...))`. No servers, no network; fake `fetch` for outbound calls.
- The tracker is tested by running the real string against a fake browser (`test/script.test.ts`). Anything that touches the DOM also gets a real-browser check using `examples/events`.
- Postgres SQL runs against PGlite in every test run and against a real server in `test:services`. Do not mock SQL.
- Every bug fix gets a regression test. Every new option gets a test.

## Don'ts

- No cookies, `localStorage` writes, fingerprinting, or third-party calls from the core (including IP-geolocation APIs).
- No dashboard UI in this package.
- Do not commit `dist/`, `node_modules/`, `.env`, `*.db` or `*.tgz`.
- Do not relicense or add files under an incompatible license. Contributions are AGPL-3.0-only.
