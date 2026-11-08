import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withApp } from './harness.mts'

test('mcp install: registers with Cursor and VS Code in a fake home, keeps other servers, refuses unsafe files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'deadletter-home-'))
  const appData = join(home, 'AppData', 'Roaming')
  const cursorFile = join(home, '.cursor', 'mcp.json')
  const vscodeFile = join(appData, 'Code', 'User', 'mcp.json')
  mkdirSync(join(home, '.cursor'), { recursive: true })
  mkdirSync(join(appData, 'Code', 'User'), { recursive: true })
  writeFileSync(cursorFile, JSON.stringify({ mcpServers: { other: { url: 'http://elsewhere/mcp' } } }))
  // VS Code files often hold comments; rewriting would delete them, so the app must refuse.
  const commented = '{\n  // my servers\n  "servers": {}\n}\n'
  writeFileSync(vscodeFile, commented)

  try {
    await withApp(
      { env: { USERPROFILE: home, HOME: home, APPDATA: appData } },
      async ({ page, pageErrors }) => {
        const port = 40000 + Math.floor(Math.random() * 20000)
        await page.evaluate((p) => window.deadletter.mcp.configure({ port: p }), port)
        await page.getByRole('button', { name: 'Settings' }).click()
        await page.getByRole('button', { name: 'Enable MCP server' }).click()
        const tools = page.getByLabel('AI tools')
        await tools.waitFor()
        const token = (await page.evaluate(() => window.deadletter.mcp.status())).token

        // Nothing is written until the user presses a button.
        assert.equal(readFileSync(cursorFile, 'utf8').includes('deadletter'), false)

        await page.getByRole('button', { name: 'Install in Cursor' }).click()
        await page.getByRole('button', { name: 'Remove from Cursor' }).waitFor()
        const cursor = JSON.parse(readFileSync(cursorFile, 'utf8'))
        assert.equal(cursor.mcpServers.other.url, 'http://elsewhere/mcp')
        assert.equal(cursor.mcpServers.deadletter.url, `http://127.0.0.1:${port}/mcp`)
        assert.equal(cursor.mcpServers.deadletter.headers.Authorization, `Bearer ${token}`)
        if (process.platform !== 'win32') assert.equal(statSync(cursorFile).mode & 0o077, 0, 'config holds a token: owner-only')

        // The commented file is left exactly as it was, and the user is told why.
        await page.getByRole('button', { name: 'Install in VS Code' }).click()
        await page.getByRole('status').filter({ hasText: 'not plain JSON' }).waitFor()
        assert.equal(readFileSync(vscodeFile, 'utf8'), commented)

        // With a clean file VS Code gets its own schema (servers + type: http).
        writeFileSync(vscodeFile, '{}')
        await page.getByRole('button', { name: 'Install in VS Code' }).click()
        await page.getByRole('button', { name: 'Remove from VS Code' }).waitFor()
        const vscode = JSON.parse(readFileSync(vscodeFile, 'utf8'))
        assert.equal(vscode.servers.deadletter.type, 'http')
        assert.equal(vscode.servers.deadletter.url, `http://127.0.0.1:${port}/mcp`)

        // Removing takes only our entry out.
        await page.getByRole('button', { name: 'Remove from Cursor' }).click()
        await page.getByRole('button', { name: 'Install in Cursor' }).waitFor()
        assert.deepEqual(JSON.parse(readFileSync(cursorFile, 'utf8')), { mcpServers: { other: { url: 'http://elsewhere/mcp' } } })
        assert.deepEqual(pageErrors, [])
      }
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  assert.equal(existsSync(home), false)
})

test('mcp install: refuses to install while the server is off', async () => {
  await withApp({}, async ({ page }) => {
    const err = await page.evaluate(() => window.deadletter.mcp.installClient('cursor').then(() => null, (e: Error) => e.message))
    assert.match(err ?? '', /Enable the MCP server first/)
  })
})
