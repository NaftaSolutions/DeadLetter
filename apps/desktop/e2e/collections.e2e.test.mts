import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

const LOGIN_HTTP =
  '### Login\nPOST http://127.0.0.1:1/login\nContent-Type: application/json\n# X-Off: 1\n\n{"u":1}\n'
const read = (p: string): string => readFileSync(p, 'utf8')

test('sidebar lists files of both formats and hides unrelated json', async () => {
  await withApp(
    {
      files: {
        'Auth/login.http': LOGIN_HTTP,
        'ping.json': JSON.stringify({ name: 'Ping', method: 'GET', url: 'http://x/ping' }),
        'package.json': '{"name":"noise"}'
      }
    },
    async ({ page, shot, pageErrors }) => {
      const tree = page.locator('[role=tree]')
      await eventually(async () => /Auth/.test(await tree.innerText()), 'tree populated')
      const text = await tree.innerText()
      assert.match(text, /Ping/)
      assert.doesNotMatch(text, /noise|package/)
      await shot('01-sidebar')
      assert.deepEqual(pageErrors, [])
    }
  )
})

test('open, edit, send and save an .http request without losing disabled headers', async () => {
  await withApp({ files: { 'login.http': '' } }, async ({ page, ws, api, shot }) => {
    writeFileSync(join(ws, 'login.http'), LOGIN_HTTP.replace('http://127.0.0.1:1', api))
    const url = page.getByLabel('Request URL')
    await page.locator('button[title="login.http"]').click()
    await eventually(async () => (await url.inputValue()).endsWith('/login'), 'request opened')
    await shot('02-request-open')

    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByText(/"ok": ?true/).waitFor({ timeout: 8000 })
    await shot('03-response')

    await url.fill(`${api}/login2`)
    await page.getByText('● unsaved').waitFor()
    await shot('04-unsaved')
    await page.keyboard.press('Control+s')
    await page.getByText('● unsaved').waitFor({ state: 'hidden' })

    const saved = read(join(ws, 'login.http'))
    assert.match(saved, /^### Login\nPOST .*\/login2\n/)
    assert.match(saved, /# X-Off: 1/)
    assert.match(saved, /\{"u":1\}/)
  })
})

test('settings choose the format of new requests', async () => {
  await withApp({}, async ({ page, ws, userData, shot }) => {
    const create = async (name: string): Promise<void> => {
      await page.getByRole('button', { name: 'New request', exact: true }).click()
      await page.getByLabel('New request name').fill(name)
      await page.keyboard.press('Enter')
    }

    await create('Get users')
    await eventually(() => existsSync(join(ws, 'Get-users.http')), '.http created by default')

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('radio').nth(1).click()
    await page.getByRole('radio').nth(1).waitFor()
    await eventually(
      () => JSON.parse(read(join(userData, 'settings.json'))).preferredFormat === 'json',
      'preference persisted'
    )
    await shot('05-settings')
    await page.keyboard.press('Escape')

    await create('Make order')
    await eventually(() => existsSync(join(ws, 'Make-order.json')), '.json created after switching')
    const created = JSON.parse(read(join(ws, 'Make-order.json')))
    assert.equal(created.name, 'Make order')
    await shot('06-both-formats')
  })
})

test('external changes show up live', async () => {
  await withApp({ files: { 'ping.json': JSON.stringify({ name: 'Ping', method: 'GET', url: 'http://x/a' }) } }, async ({ page, ws }) => {
    const url = page.getByLabel('Request URL')
    await page.locator('button[title="ping.json"]').click()
    await eventually(async () => (await url.inputValue()) === 'http://x/a', 'opened')

    writeFileSync(join(ws, 'ping.json'), JSON.stringify({ name: 'Ping', method: 'GET', url: 'http://x/b' }))
    await eventually(async () => (await url.inputValue()) === 'http://x/b', 'open request reloaded')

    writeFileSync(join(ws, 'fresh.http'), 'GET http://x/fresh\n')
    await eventually(async () => /fresh/.test(await page.locator('[role=tree]').innerText()), 'new file listed')
  })
})

test('local edits are not overwritten by an external change', async () => {
  await withApp({ files: { 'a.http': 'GET http://x/a\n' } }, async ({ page, ws }) => {
    const url = page.getByLabel('Request URL')
    await page.locator('button[title="a.http"]').click()
    await eventually(async () => (await url.inputValue()) === 'http://x/a', 'opened')
    await url.fill('http://x/mine')
    writeFileSync(join(ws, 'a.http'), 'GET http://x/theirs\n')
    await new Promise((r) => setTimeout(r, 1000))
    assert.equal(await url.inputValue(), 'http://x/mine')
  })
})

test('rename keeps the editor on the file; delete closes it; folders work', async () => {
  await withApp({ files: { 'ping.json': JSON.stringify({ name: 'Ping', method: 'GET', url: 'http://x/a' }) } }, async ({ page, ws }) => {
    const url = page.getByLabel('Request URL')
    await page.locator('button[title="ping.json"]').click()
    await eventually(async () => (await url.inputValue()) === 'http://x/a', 'opened')

    await page.getByRole('button', { name: 'Rename Ping' }).click({ force: true })
    await page.getByLabel('New name').fill('Pong')
    await page.keyboard.press('Enter')
    await eventually(() => existsSync(join(ws, 'Pong.json')) && !existsSync(join(ws, 'ping.json')), 'renamed on disk')
    assert.equal(await url.inputValue(), 'http://x/a')

    await page.getByRole('button', { name: 'New folder', exact: true }).click()
    await page.getByLabel('New folder name').fill('Billing')
    await page.keyboard.press('Enter')
    await eventually(() => existsSync(join(ws, 'Billing')), 'folder created')

    await page.getByRole('button', { name: 'Delete Pong' }).click({ force: true })
    await eventually(async () => !existsSync(join(ws, 'Pong.json')) && (await url.inputValue()) === '', 'deleted and closed')
  })
})

test('a .http file with several requests is shown but refused, never truncated', async () => {
  const multi = '### a\nGET http://x/a\n\n### b\nGET http://x/b\n'
  await withApp({ files: { 'multi.http': multi } }, async ({ page, ws, shot }) => {
    await page.locator('button[title="multi.http"]').click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /several requests/)
    await shot('07-error-banner')
    assert.equal(read(join(ws, 'multi.http')), multi)
  })
})

test('closing the window with unsaved edits asks first', async () => {
  await withApp({ files: { 'a.http': 'GET http://x/a\n' } }, async ({ app, page }) => {
    const url = page.getByLabel('Request URL')
    await page.locator('button[title="a.http"]').click()
    await eventually(async () => (await url.inputValue()) === 'http://x/a', 'opened')
    await url.fill('http://x/edited')
    await page.getByText('● unsaved').waitFor()
    // Let the renderer's dirty flag reach the main process.
    await new Promise((r) => setTimeout(r, 200))

    const closeAttempt = (choice: number) =>
      app.evaluate(async ({ BrowserWindow, dialog }, c) => {
        let asked = 0
        dialog.showMessageBoxSync = () => (asked++, c)
        BrowserWindow.getAllWindows()[0]?.close()
        return { asked, open: BrowserWindow.getAllWindows().length }
      }, choice)

    const cancelled = await closeAttempt(1) // "Cancel"
    assert.equal(cancelled.asked, 1)
    assert.equal(cancelled.open, 1, 'window stays open when the user cancels')
    assert.equal(await url.inputValue(), 'http://x/edited')
  })
})
