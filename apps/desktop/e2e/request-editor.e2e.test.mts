import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

const read = (p: string): string => readFileSync(p, 'utf8')

test('auth helper writes the Authorization header and Basic credentials are encoded on send', async () => {
  await withApp({ files: { 'r.http': '### R\nGET http://x\n' } }, async ({ page, ws, api, shot, pageErrors }) => {
    await page.locator('button[title="r.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill(`${api}/auth`)

    const request = page.getByLabel('Request', { exact: true })
    await request.getByRole('tab', { name: /^Auth/ }).click()
    await page.getByLabel('Auth type').selectOption('basic')
    await page.getByLabel('Username').fill('ada')
    await page.getByLabel('Password').fill('p w')
    await shot('09-auth-basic')

    // The helper is just a view over the header, so it shows up there too.
    await request.getByRole('tab', { name: /^Headers/ }).click()
    assert.equal(await page.getByLabel('Header 1 value').inputValue(), 'Basic ada:p w')

    await page.getByRole('button', { name: /^Send/ }).click()
    const expected = `Basic\\s${Buffer.from('ada:p w').toString('base64')}`
    await page.getByTestId('code-viewer').getByText(new RegExp(`"auth":\\s"${expected}"`)).waitFor({ timeout: 8000 })

    await page.keyboard.press('Control+s')
    await eventually(() => /Authorization: Basic ada:p w\n/.test(read(join(ws, 'r.http'))), 'saved as plain header')

    // Bearer with a variable-friendly token, then removing the helper again.
    await request.getByRole('tab', { name: /^Auth/ }).click()
    await page.getByLabel('Auth type').selectOption('bearer')
    await page.getByLabel('Bearer token').fill('tok123')
    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByTestId('code-viewer').getByText(/"auth":\s"Bearer\stok123"/).waitFor({ timeout: 8000 })
    await page.getByLabel('Auth type').selectOption('none')
    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByTestId('code-viewer').getByText(/"auth":\snull/).waitFor({ timeout: 8000 })
    assert.deepEqual(pageErrors, [])
  })
})

test('urlencoded form body sends encoded fields and keeps the file readable', async () => {
  await withApp({ files: { 'r.http': '### R\nPOST http://x\n' } }, async ({ page, ws, api, shot, pageErrors }) => {
    await page.locator('button[title="r.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill(`${api}/form`)

    await page.getByLabel('Request', { exact: true }).getByRole('tab', { name: /^Body/ }).click()
    await page.getByRole('radio', { name: 'Form (urlencoded)' }).click()
    await page.getByLabel('Field 1 name').fill('q')
    await page.getByLabel('Field 1 value').fill('a b&c')
    await page.getByLabel('Field 2 name').fill('tok')
    await page.getByLabel('Field 2 value').fill('{{missing}}')
    await shot('10-body-form')

    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByText(/Undefined variable: \{\{missing\}\}/).waitFor({ timeout: 8000 })

    await page.getByLabel('Field 2 value').fill('x')
    await page.getByRole('button', { name: /^Send/ }).click()
    const viewer = page.getByTestId('code-viewer')
    await viewer.getByText(/"body":\s"q=a%20b%26c&tok=x"/).waitFor({ timeout: 8000 })
    await viewer.getByText(/"type":\s"application\/x-www-form-urlencoded"/).waitFor()

    await page.keyboard.press('Control+s')
    await eventually(() => {
      const saved = read(join(ws, 'r.http'))
      return /Content-Type: application\/x-www-form-urlencoded\n\nq=a%20b%26c&tok=x\n$/.test(saved)
    }, 'saved as a plain form body')
    assert.deepEqual(pageErrors, [])
  })
})

test('graphql body is stored as the standard JSON envelope and reopens in GraphQL mode', async () => {
  await withApp({ files: { 'g.http': '### G\nPOST http://x\n' } }, async ({ page, ws, api, shot, pageErrors }) => {
    await page.locator('button[title="g.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill(`${api}/graphql`)

    const request = page.getByLabel('Request', { exact: true })
    await request.getByRole('tab', { name: /^Body/ }).click()
    await page.getByRole('radio', { name: 'GraphQL' }).click()
    await page.getByLabel('GraphQL query').fill('query($id: ID!) { user(id: $id) { name } }')
    await page.getByLabel('GraphQL variables').fill('{ "id": ')
    await page.getByRole('alert').filter({ hasText: /not valid JSON/ }).waitFor()
    await page.getByLabel('GraphQL variables').fill('{ "id": 7 }')
    await page.getByRole('alert').filter({ hasText: /not valid JSON/ }).waitFor({ state: 'hidden' })
    await shot('11-body-graphql')

    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByTestId('code-viewer').getByText(/"type":\s"application\/json"/).waitFor({ timeout: 8000 })
    await page.keyboard.press('Control+s')
    await eventually(() => {
      const saved = read(join(ws, 'g.http'))
      return saved.includes('Content-Type: application/json') && saved.includes('"query": "query($id: ID!)') && saved.includes('"id": 7')
    }, 'saved as JSON envelope')

    // Reopen: the mode is derived from the file, nothing extra is stored.
    await page.getByLabel('Request URL').fill(`${api}/other`)
    await page.keyboard.press('Control+s')
    await page.locator('button[title="g.http"]').click()
    await request.getByRole('tab', { name: /^Body/ }).click()
    assert.equal(await page.getByRole('radio', { name: 'GraphQL' }).getAttribute('aria-checked'), 'true')
    assert.match(await page.getByLabel('GraphQL query').inputValue(), /user\(id: \$id\)/)
    assert.deepEqual(pageErrors, [])
  })
})
