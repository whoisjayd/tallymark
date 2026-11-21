import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'tallymark-cli-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

async function boot(env: Record<string, string>) {
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const proc = Bun.spawn(['bun', CLI], {
    env: {
      ...process.env,
      PORT: String(port),
      TALLYMARK_SECRET: 's',
      TALLYMARK_API_KEY: 'k',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { proc, base }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(50)
  }
  proc.kill()
  throw new Error(`cli did not start: ${await new Response(proc.stderr).text()}`)
}

describe('cli', () => {
  test('serves collect + read API from a real SQLite file and persists across restarts', async () => {
    const dbFile = join(dir, 'stats.db')
    const first = await boot({ TALLYMARK_DB: dbFile })
    const res = await fetch(`${first.base}/collect`, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'text/plain' },
      body: JSON.stringify({ url: 'https://example.com/hello?utm_source=hn' }),
    })
    expect(res.status).toBe(202)
    first.proc.kill()
    await first.proc.exited

    const second = await boot({ TALLYMARK_DB: dbFile })
    const summary = (await (
      await fetch(`${second.base}/api/summary?range=24h`, {
        headers: { authorization: 'Bearer k' },
      })
    ).json()) as any
    expect(summary.data.pageviews).toBe(1)
    const top = (await (
      await fetch(`${second.base}/api/top?by=utm_source`, {
        headers: { authorization: 'Bearer k' },
      })
    ).json()) as any
    expect(top.data[0].key).toBe('hn')
    second.proc.kill()
    await second.proc.exited
  })

  test('uses the socket IP when not behind a proxy (spoofed XFF is ignored)', async () => {
    const { proc, base } = await boot({ TALLYMARK_DB: ':memory:' })
    const send = (xff: string) =>
      fetch(`${base}/collect`, {
        method: 'POST',
        headers: { 'user-agent': UA, 'x-forwarded-for': xff },
        body: '{"url":"https://example.com/"}',
      })
    await send('1.1.1.1')
    await send('2.2.2.2')
    const s = (await (
      await fetch(`${base}/api/summary?range=24h`, { headers: { authorization: 'Bearer k' } })
    ).json()) as any
    expect(s.data.visitors).toBe(1) // same socket, same UA => one visitor despite two spoofed IPs
    proc.kill()
    await proc.exited
  })

  test('rejects invalid configuration with a clear message and non-zero exit', async () => {
    for (const env of [
      { PORT: 'abc' },
      { TALLYMARK_RETENTION_DAYS: '-1' },
      { TALLYMARK_STRICT_ORIGIN: 'true' },
    ]) {
      const proc = Bun.spawn(['bun', CLI], {
        env: { ...process.env, TALLYMARK_DB: ':memory:', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(1)
      expect(await new Response(proc.stderr).text()).toContain('tallymark:')
    }
  })
})
