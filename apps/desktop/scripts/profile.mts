// Launch profiler: `node scripts/profile.mts [path-to-DeadLetter.exe]` (defaults to the built dev app).
// Reports startup time, process memory, and UI responsiveness while a large response is shown.
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv[2]
const executablePath = packaged ?? (createRequire(import.meta.url)('electron') as string)
const sizesMb = [1, 5, 20]

const root = mkdtempSync(join(tmpdir(), 'deadletter-prof-'))
const ws = join(root, 'ws')
const userData = join(root, 'ud')
mkdirSync(ws, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(ws, 'r.http'), '### R\nGET http://x\n')
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ workspacePath: ws, preferredFormat: 'http' }))

const payload = (mb: number): string => {
  const row = JSON.stringify({ id: 1, name: 'item', tags: ['a', 'b'], nested: { ok: true, n: 3.14 } })
  return `[${Array(Math.ceil((mb * 1024 * 1024) / (row.length + 1))).fill(row).join(',')}]`
}
const bodies = new Map(sizesMb.map((mb) => [`/${mb}`, payload(mb)]))
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(bodies.get(req.url ?? '') ?? '{}')
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const t0 = performance.now()
const app = await _electron.launch({
  executablePath,
  args: [`--user-data-dir=${userData}`, ...(packaged ? [] : [desktopDir])]
})
const page = await app.firstWindow()
await page.waitForSelector('[role=tree]')
const startupMs = performance.now() - t0

const memory = async (): Promise<string> => {
  const m = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, kb: p.memory.workingSetSize })))
  const total = m.reduce((a, p) => a + p.kb, 0)
  const renderer = m.filter((p) => p.type === 'Tab').reduce((a, p) => a + p.kb, 0)
  return `${(total / 1024).toFixed(0)} MB total, ${(renderer / 1024).toFixed(0)} MB renderer, ${m.length} procs`
}

await new Promise((r) => setTimeout(r, 1500))
console.log(`startup (launch -> sidebar rendered): ${startupMs.toFixed(0)} ms`)
console.log(`idle memory: ${await memory()}`)

await page.evaluate(() => {
  const w = window as unknown as { __long: number[] }
  w.__long = []
  new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ entryTypes: ['longtask'] })
})
await page.locator('button[title="r.http"]').click()
const url = page.getByLabel('Request URL')
for (const mb of sizesMb) {
  await url.fill(`${api}/${mb}`)
  await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0))
  const t = performance.now()
  await page.getByRole('button', { name: /^Send/ }).click()
  let shown = -1
  try {
    await page.getByLabel('Response summary').waitFor({ timeout: 90000 })
    shown = performance.now() - t
    await page.getByRole('button', { name: 'Raw', exact: true }).waitFor({ timeout: 90000 }) // pretty-print finished
  } catch {}
  const pretty = performance.now() - t
  await new Promise((r) => setTimeout(r, 500))
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long)
  const worst = long.length ? Math.max(...long) : 0
  console.log(`${mb} MB response: summary ${shown.toFixed(0)} ms, pretty ${pretty.toFixed(0)} ms, ${long.length} long tasks, worst ${worst.toFixed(0)} ms, ${await memory()}`)
}

await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))])
app.process().kill()
server.close()
try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
