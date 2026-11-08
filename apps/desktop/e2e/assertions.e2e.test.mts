import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

test('assertions: stored as @assert comments, checked on Send, results listed', async () => {
  const file = '### A\n# @assert status == 200\n# @assert json $.method == GET\nGET http://x\n'
  await withApp({ files: { 'a.http': file } }, async ({ page, ws, api, pageErrors }) => {
    await page.locator('button[title="a.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill(`${api}/things`)

    const request = page.getByLabel('Request', { exact: true })
    await request.getByRole('tab', { name: /^Tests/ }).click()
    assert.equal(await page.getByRole('textbox', { name: 'Assertion 1' }).inputValue(), 'status == 200')
    await page.getByRole('button', { name: 'Add assertion' }).click()
    await page.getByRole('textbox', { name: 'Assertion 3' }).fill('json $.path == /nope')

    await page.getByRole('button', { name: /^Send/ }).click()
    const response = page.getByLabel('Response', { exact: true })
    await response.getByRole('tab', { name: /^Tests/ }).click()
    const results = page.getByLabel('Test results')
    await results.getByText('2 of 3 passed').waitFor({ timeout: 8000 })
    await results.getByText(/json \$\.path: expected == "\/nope", got "\/things"/).waitFor()

    await page.keyboard.press('Control+s')
    await eventually(() => {
      const saved = readFileSync(join(ws, 'a.http'), 'utf8')
      return saved.includes('# @assert status == 200\n# @assert json $.method == GET\n# @assert json $.path == /nope\nGET ')
    }, 'assertions saved as comment lines')
    assert.deepEqual(pageErrors, [])
  })
})
