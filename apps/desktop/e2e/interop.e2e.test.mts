import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

const read = (p: string): string => readFileSync(p, 'utf8')

const POSTMAN = JSON.stringify({
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://shop.test' }],
  item: [
    {
      name: 'Users',
      item: [
        {
          name: 'List',
          event: [{ listen: 'test' }],
          request: { method: 'GET', url: { raw: '{{baseUrl}}/users?page=1' }, auth: { type: 'bearer', bearer: [{ key: 'token', value: 'abc' }] } }
        }
      ]
    },
    { name: 'Upload', request: { method: 'POST', url: '{{baseUrl}}/up', body: { mode: 'formdata', formdata: [] } } }
  ]
})

test('import a cURL command, import a Postman file, copy as cURL and export', async () => {
  await withApp({}, async ({ app, page, ws, api, shot, pageErrors }) => {
    const dialog = page.getByRole('dialog', { name: 'Import & export' })
    const openDialog = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Import and export' }).click()
      await dialog.waitFor()
    }

    // 1. cURL -> request opened in the editor, saved as a plain file.
    await openDialog()
    await page.getByLabel('cURL command').fill(`curl -u ada:pw -X POST '${api}/it' \\\n  -H 'X-A: 1' -d 'a=1&b=2'`)
    await shot('12-import-curl')
    await page.getByRole('button', { name: 'Import request' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === `${api}/it`, 'imported request opened')
    const saved = read(join(ws, 'it.http'))
    assert.match(saved, /^### it\nPOST .*\/it\n/)
    assert.match(saved, /Authorization: Basic ada:pw\n/)
    assert.match(saved, /Content-Type: application\/x-www-form-urlencoded\n\na=1&b=2\n$/)

    // 2. Postman file -> new folder, environment from collection variables, warnings shown.
    const file = join(dirname(ws), 'shop.postman.json')
    writeFileSync(file, POSTMAN)
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, file)
    await openDialog()
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await dialog.getByText(/Imported 2 requests from Postman into/).waitFor({ timeout: 8000 })
    await dialog.getByText(/scripts, which are not imported/).waitFor()
    await dialog.getByText(/form-data bodies are not supported/).waitFor()
    await shot('13-import-result')
    assert.ok(existsSync(join(ws, 'Shop', 'Users', 'List.http')))
    assert.match(read(join(ws, 'Shop', 'Users', 'List.http')), /Authorization: Bearer abc\n/)
    assert.match(read(join(ws, '.deadletter', 'environments', 'Shop.json')), /https:\/\/shop\.test/)
    await page.getByRole('button', { name: 'Close import and export' }).click()

    // 3. Copy as cURL with the new environment active.
    await page.getByLabel('Active environment').selectOption('Shop')
    await eventually(async () => (await page.locator('[role=tree]').innerText()).includes('Shop'), 'tree has Shop')
    await page.locator('[role=tree]').getByText('Shop', { exact: true }).click()
    await page.locator('[role=tree]').getByText('Users', { exact: true }).click()
    await page.locator('button[title="Shop/Users/List.http"]').click()
    await eventually(async () => (await url.inputValue()).startsWith('{{baseUrl}}/users'), 'List opened')
    await page.getByRole('button', { name: 'Copy cURL' }).click()
    const curl = await app.evaluate(({ clipboard }) => clipboard.readText())
    assert.match(curl, /'https:\/\/shop\.test\/users\?page=1'/)
    assert.match(curl, /-H 'Authorization: Bearer abc'/)

    // 4. Export the workspace and read it back.
    const out = join(dirname(ws), 'out.postman_collection.json')
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
    }, out)
    await openDialog()
    await page.getByRole('button', { name: 'Export as Postman…' }).click()
    await dialog.getByText(/Saved to/).waitFor({ timeout: 8000 })
    const exported = JSON.parse(read(out)) as { info: { schema: string }; item: { name: string }[] }
    assert.match(exported.info.schema, /collection\/v2\.1\.0/)
    assert.deepEqual(exported.item.map((i) => i.name).sort(), ['Shop', 'it'])
    assert.ok(readdirSync(ws).includes('Shop'))
    assert.deepEqual(pageErrors, [])
  })
})

test('import errors are explained and cancelling changes nothing', async () => {
  await withApp({}, async ({ app, page, ws, shot }) => {
    const dialog = page.getByRole('dialog', { name: 'Import & export' })
    await page.getByRole('button', { name: 'Import and export' }).click()

    await page.getByLabel('cURL command').fill('curl -F file=@x.png https://x.test')
    await page.getByRole('button', { name: 'Import request' }).click()
    await dialog.getByRole('alert').getByText(/multipart/).waitFor()

    const file = join(dirname(ws), 'spec.yaml')
    writeFileSync(file, 'openapi: 3.0.0\ninfo:\n  title: x\n')
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, file)
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await dialog.getByRole('alert').getByText(/has no "paths"/).waitFor()
    await shot('14-import-error')

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await page.getByRole('button', { name: 'Choose file…' }).click()
    await page.waitForTimeout(300)
    assert.equal(readdirSync(ws).filter((n) => !n.startsWith('.')).length, 0)
  })
})

test('imports a YAML OpenAPI spec, a Postman environment and a multi-request .http file', async () => {
  await withApp({}, async ({ app, page, ws, pageErrors }) => {
    const dialog = page.getByRole('dialog', { name: 'Import & export' })
    await page.getByRole('button', { name: 'Import and export' }).click()
    const pick = async (name: string, content: string): Promise<void> => {
      const file = join(dirname(ws), name)
      writeFileSync(file, content)
      await app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
      }, file)
      await page.getByRole('button', { name: 'Choose file…' }).click()
    }

    await pick(
      'pets.yaml',
      'openapi: 3.0.0\ninfo:\n  title: Pets\nservers:\n  - url: https://pets.test\npaths:\n  /pets/{id}:\n    get:\n      tags: [pets]\n      summary: Get a pet\n      parameters:\n        - {name: id, in: path, required: true, schema: {type: integer}}\n'
    )
    await dialog.getByText(/Imported 1 request from OpenAPI into/).waitFor({ timeout: 8000 })
    assert.match(read(join(ws, 'Pets', 'pets', 'Get-a-pet.http')), /^### Get a pet\nGET \{\{baseUrl\}\}\/pets\/\{\{id\}\}\n/)
    assert.match(read(join(ws, '.deadletter', 'environments', 'Pets.json')), /https:\/\/pets\.test/)

    await pick(
      'prod.postman_environment.json',
      JSON.stringify({ name: 'Prod', _postman_variable_scope: 'environment', values: [{ key: 'host', value: 'p.test', enabled: true }, { key: 'token', value: 'sekret', type: 'secret', enabled: true }] })
    )
    await dialog.getByText(/created the environment/).waitFor({ timeout: 8000 })
    const shared = read(join(ws, '.deadletter', 'environments', 'Prod.json'))
    assert.match(shared, /p\.test/)
    assert.doesNotMatch(shared, /sekret/)
    assert.match(read(join(ws, '.deadletter', 'environments', 'Prod.secrets.json')), /sekret/)

    await pick('api.http', '@host = https://api.test\n\n### List\nGET {{host}}/users\n\n### Create\nPOST {{host}}/users\nContent-Type: application/json\n\n{"a":1}\n')
    await dialog.getByText(/Imported 2 requests from an \.http file/).waitFor({ timeout: 8000 })
    assert.ok(existsSync(join(ws, 'Imported-http', 'List.http')) || readdirSync(ws).some((n) => n.startsWith('Imported')))
    assert.deepEqual(pageErrors, [])
  })
})
