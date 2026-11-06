import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { withApp } from './harness.mts'

const read = (p: string): string => readFileSync(p, 'utf8')

test('imports a Bruno collection folder with inherited auth and environments', async () => {
  await withApp({}, async ({ app, page, ws, shot, pageErrors }) => {
    const bruno = join(dirname(ws), 'shop-bruno')
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(bruno, rel)), { recursive: true })
      writeFileSync(join(bruno, rel), text)
    }
    put('bruno.json', JSON.stringify({ version: '1', name: 'Shop', type: 'collection' }))
    put('collection.bru', 'auth {\n  mode: bearer\n}\n\nauth:bearer {\n  token: {{token}}\n}\n')
    put('Users/list.bru', 'meta {\n  name: List\n  seq: 1\n}\n\nget {\n  url: {{baseUrl}}/users\n  body: none\n  auth: inherit\n}\n\ntests {\n  test("x", () => {});\n}\n')
    put('environments/Prod.bru', 'vars {\n  baseUrl: https://shop.test\n}\nvars:secret [\n  token\n]\n')

    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
    }, bruno)

    await page.getByRole('button', { name: 'Import and export' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import & export' })
    await dialog.getByRole('button', { name: 'Bruno folder…' }).click()
    await dialog.getByText(/Imported 1 request from Bruno into/).waitFor({ timeout: 8000 })
    await dialog.getByText(/which are not imported/).waitFor()
    await shot('16-import-bruno')

    const file = join(ws, 'Shop', 'Users', 'List.http')
    assert.ok(existsSync(file))
    assert.match(read(file), /GET \{\{baseUrl\}\}\/users\nAuthorization: Bearer \{\{token\}\}\n/)
    const envDir = join(ws, '.deadletter', 'environments')
    assert.match(read(join(envDir, 'Shop-Prod.json')), /https:\/\/shop\.test/)
    assert.ok(!existsSync(join(envDir, 'Shop-Prod.secrets.json')) || !/\S/.test(read(join(envDir, 'Shop-Prod.secrets.json')).replace(/[{}\s":,a-zA-Z]/g, '')))
    assert.deepEqual(pageErrors, [])
  })
})
