import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

test('environment variables are substituted on send and secrets stay out of the shared file', async () => {
  await withApp({ files: { 'r.http': '### R\nGET http://x\n' } }, async ({ page, ws, api, shot, pageErrors }) => {
    await page.getByRole('button', { name: 'Manage environments' }).click()
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await page.getByLabel('New environment name').fill('Staging')
    await page.keyboard.press('Enter')
    await page.getByLabel('Variable 1 name').waitFor()

    await page.getByLabel('Variable 1 name').fill('base')
    await page.getByLabel('Variable 1 value').fill(api)
    await page.getByLabel('Variable 2 name').fill('seg')
    await page.getByLabel('Variable 2 value').fill('hunter2')
    await page.getByLabel('Variable 2 secret').click()
    await shot('05-environment-dialog')
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    const dir = join(ws, '.deadletter', 'environments')
    await eventually(() => existsSync(join(dir, 'Staging.secrets.json')), 'secrets file written')
    const shared = readFileSync(join(dir, 'Staging.json'), 'utf8')
    assert.match(shared, new RegExp(api.replace(/[.]/g, '\\.')))
    assert.doesNotMatch(shared, /hunter2/)
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\*\.secrets\.json/)
    assert.match(readFileSync(join(dir, 'Staging.secrets.json'), 'utf8'), /hunter2/)
    await page.getByRole('button', { name: 'Close', exact: true }).click()

    await page.getByLabel('Active environment').selectOption('Staging')
    await page.locator('button[title="r.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill('{{base}}/{{seg}}')
    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByText(/"path":\s?"\/hunter2"/).waitFor({ timeout: 8000 })
    await shot('06-substituted-response')

    await url.fill('{{base}}/{{nope}}')
    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByText(/Undefined variable: \{\{nope\}\}/).waitFor({ timeout: 8000 })

    // Choice survives in settings, and "No environment" leaves placeholders undefined.
    await page.getByLabel('Active environment').selectOption('')
    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByText(/Undefined variables?: /).waitFor({ timeout: 8000 })
    assert.deepEqual(pageErrors, [])
  })
})
