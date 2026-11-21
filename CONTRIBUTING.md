# CONTRIBUTING

Tallymark is deliberately small. The best patches keep it that way.

By contributing you agree that your work is licensed under **AGPL-3.0-only**, and to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Setup

1. Fork and clone, then `bun install`. That installs the git hooks. CI uses the Bun version in `.bun-version`.
2. Read [AGENTS.md](./AGENTS.md). It describes the layout and the rules that must hold: zero runtime dependencies, a runtime-neutral core, and the privacy invariants.

The pre-commit hook formats staged files with Biome and restages the fixes. The commit-msg hook accepts only one [Conventional Commit](./AGENTS.md#commits) line. Neither hook runs the test suite.

## Changing the code

1. Make your change with a test. Every bug fix gets a regression test and every new option gets a test.
2. Run `bun run check`. If you touched a store, also run `bun run services && bun run test:services`. Before a release-affecting change, run `bun run build && bun run smoke && bun run validate`.
3. If you changed behaviour, update `docs/USAGE.md`, `llms.txt` and the README together.
4. Open a pull request that explains *why*, not just *what*.

If you change the browser script, check it in a real browser as well as in the tests: run `bun examples/events/server.ts`, open `http://localhost:3000`, click every button, and read `/stats`.

## What CI runs

On a pull request or a push to `main`, the `ci` check always reports. You can also run the full suite from the Actions tab with "Run workflow".

When the diff touches `src/`, `test/`, a TypeScript example, `scripts/`, the package manifest, the lockfile, the Docker files, Biome, the hooks, or a workflow, CI also runs format and lint, the typecheck and tests on Ubuntu, Windows and macOS, the store suite against real PostgreSQL and Redis, the package checks, and a Docker build. A change that is only documentation, issue templates, or the other-language HTTP examples skips those jobs, and `ci` still passes.

If you protect `main`, require the `ci` check. Requiring a job that is skipped for documentation would leave the pull request waiting.

CodeQL runs on those same code paths, and again every Monday, including when nobody pushed.

## Good first contributions

A new storage driver, a new example for another framework, a missing dimension, and documentation fixes.
