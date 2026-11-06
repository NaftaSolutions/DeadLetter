import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const electronPath = createRequire(import.meta.url)('electron') as string
export const screenshotDir = join(desktopDir, 'test-results')

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until `fn` is truthy; the UI talks to the main process asynchronously. */
export async function eventually<T>(fn: () => T | Promise<T>, what: string, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* retry */
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`)
    await sleep(50)
  }
}

export interface Ctx {
  app: ElectronApplication
  page: Page
  /** Workspace folder the app was pointed at. */
  ws: string
  /** Electron userData folder (holds settings.json). */
  userData: string
  /** Base URL of a local echo server for Send tests. */
  api: string
  pageErrors: string[]
  shot: (name: string) => Promise<void>
}

interface Options {
  files?: Record<string, string>
  preferredFormat?: 'json' | 'http'
}

/** Starts the built app against a temp workspace + local API, runs `fn`, always cleans up. */
export async function withApp(opts: Options, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'deadletter-e2e-'))
  const ws = join(root, 'workspace')
  const userData = join(root, 'user-data')
  mkdirSync(ws, { recursive: true })
  mkdirSync(userData, { recursive: true })
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true })
    writeFileSync(join(ws, rel), content)
  }
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ workspacePath: ws, preferredFormat: opts.preferredFormat ?? 'http' })
  )

  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/cookies') {
      res.setHeader('set-cookie', ['sid=abc123; Path=/; HttpOnly', 'theme=dark; Max-Age=3600'])
    }
    res.end(JSON.stringify({ ok: true, method: req.method, path: req.url }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userData}`, desktopDir]
  })
  const proc = app.process()
  try {
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()))
    page.on('dialog', (d) => d.accept().catch(() => {}))
    await page.waitForSelector('[role=tree]')
    mkdirSync(screenshotDir, { recursive: true })
    const shot = async (name: string): Promise<void> => {
      await page.screenshot({ path: join(screenshotDir, `${name}.png`) })
    }
    await fn({ app, page, ws, userData, api: `http://127.0.0.1:${port}`, pageErrors, shot })
  } finally {
    // A dirty window pops a native "discard?" box on close; never let a test hang on it.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 0
    }).catch(() => {})
    await Promise.race([app.close(), sleep(5000)])
    proc.kill()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
}
