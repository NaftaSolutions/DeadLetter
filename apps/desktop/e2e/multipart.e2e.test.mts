import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

const read = (p: string): string => readFileSync(p, 'utf8')

test('multipart form-data: text fields are sent with CRLF boundaries and reopen in Form-data mode', async () => {
  await withApp({ files: { 'u.http': '### U\nPOST http://x\n' } }, async ({ app, page, ws, api, shot, pageErrors }) => {
    await page.locator('button[title="u.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill(`${api}/upload`)

    const request = page.getByLabel('Request', { exact: true })
    await request.getByRole('tab', { name: /^Body/ }).click()
    await page.getByRole('radio', { name: 'Form-data' }).click()
    await page.getByLabel('Field 1 name').fill('title')
    await page.getByLabel('Field 1 value').fill('two words')
    await page.getByLabel('Field 2 name').fill('id')
    await page.getByLabel('Field 2 value').fill('{{missing}}')
    await shot('15-body-formdata')

    await page.getByRole('button', { name: /^Send/ }).click()
    await page.getByText(/Undefined variable: \{\{missing\}\}/).waitFor({ timeout: 8000 })

    await page.getByLabel('Field 2 value').fill('7')
    await page.getByRole('button', { name: /^Send/ }).click()
    const viewer = page.getByTestId('code-viewer')
    await viewer.getByText(/"type":\s"multipart\/form-data;\sboundary=----DeadLetterFormBoundary"/).waitFor({ timeout: 8000 })
    // The echo shows the raw body JSON-escaped; copy it (Monaco wraps long lines) and check every
    // line break reached the server as CRLF.
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    const shown = await app.evaluate(({ clipboard }) => clipboard.readText())
    assert.match(shown, /name=\\"title\\"\\r\\n\\r\\ntwo words\\r\\n/)
    assert.match(shown, /name=\\"id\\"\\r\\n\\r\\n7\\r\\n/)
    assert.match(shown, /----DeadLetterFormBoundary--\\r\\n/)

    await page.keyboard.press('Control+s')
    await eventually(() => {
      const saved = read(join(ws, 'u.http'))
      return (
        /Content-Type: multipart\/form-data; boundary=----DeadLetterFormBoundary\n\n/.test(saved) &&
        /name="title"\n\ntwo words\n/.test(saved) &&
        !saved.includes('\r')
      )
    }, 'saved as a plain multipart body')

    // Reopen: the mode is derived from the file.
    await page.getByLabel('Request URL').fill(`${api}/other`)
    await page.keyboard.press('Control+s')
    await page.locator('button[title="u.http"]').click()
    await request.getByRole('tab', { name: /^Body/ }).click()
    assert.equal(await page.getByRole('radio', { name: 'Form-data' }).getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByLabel('Field 1 value').inputValue(), 'two words')
    assert.deepEqual(pageErrors, [])
  })
})
