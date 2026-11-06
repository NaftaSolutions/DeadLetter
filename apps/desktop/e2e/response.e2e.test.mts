import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

test('response viewer pretty-prints JSON, toggles raw, lists cookies and headers', async () => {
  await withApp({ files: { 'r.http': '### R\nGET http://x\n' } }, async ({ page, api, shot, pageErrors }) => {
    await page.locator('button[title="r.http"]').click()
    const url = page.getByLabel('Request URL')
    await eventually(async () => (await url.inputValue()) === 'http://x', 'request opened')
    await url.fill(`${api}/cookies`)
    await page.getByRole('button', { name: /^Send/ }).click()

    const response = page.getByLabel('Response', { exact: true })
    const viewer = page.getByTestId('code-viewer')
    const lines = viewer.locator('.view-line')
    // The echo server answers with compact one-line JSON; the engine pretty-prints it.
    await eventually(async () => (await lines.count()) >= 4, 'pretty-printed body')
    assert.match(await viewer.innerText(), /"method":\s"GET"/)
    await shot('07-response-pretty')

    await page.getByRole('button', { name: 'Raw', exact: true }).click()
    await eventually(async () => (await lines.count()) === 1, 'raw body is a single line')
    await page.getByRole('button', { name: 'Pretty', exact: true }).click()
    await eventually(async () => (await lines.count()) >= 4, 'pretty again')

    await response.getByRole('tab', { name: /^Cookies/ }).click()
    const table = page.getByRole('table')
    await table.getByText('sid', { exact: true }).waitFor()
    await table.getByText('abc123').waitFor()
    await table.getByText('Path=/; HttpOnly').waitFor()
    await table.getByText('Max-Age=3600').waitFor()
    await shot('08-response-cookies')

    await response.getByRole('tab', { name: /^Headers/ }).click()
    await response.getByText('application/json').first().waitFor()
    assert.deepEqual(pageErrors, [])
  })
})
