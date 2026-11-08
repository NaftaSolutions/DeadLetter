import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withApp } from './harness.mts'

test('runner: runs a folder in order, reports assertion failures, and skips streams', async () => {
  await withApp(
    {
      files: {
        'suite/a-ok.http': '### A ok\n# @assert status == 200\n# @assert json $.path == /a\nGET http://x\n',
        'suite/b-bad.http': '### B bad\n# @assert json $.path == /nope\nGET http://x\n',
        'suite/c-stream.http': '### C stream\nGET ws://127.0.0.1:1/socket\n',
        'outside.http': '### Outside\nGET http://x\n'
      }
    },
    async ({ page, api, ws, pageErrors }) => {
      // Point the HTTP requests at the local echo server.
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      writeFileSync(join(ws, 'suite/a-ok.http'), `### A ok\n# @assert status == 200\n# @assert json $.path == /a\nGET ${api}/a\n`)
      writeFileSync(join(ws, 'suite/b-bad.http'), `### B bad\n# @assert json $.path == /nope\nGET ${api}/b\n`)
      writeFileSync(join(ws, 'outside.http'), `### Outside\nGET ${api}/o\n`)

      await page.getByRole('button', { name: 'Run suite' }).click({ force: true })
      const dialog = page.getByRole('dialog', { name: /Run suite/ })
      await dialog.getByText('Finished: 1 passed, 1 failed, 1 skipped of 3').waitFor({ timeout: 10000 })

      const rows = await dialog.getByLabel('Run results').getByRole('listitem').allInnerTexts()
      assert.equal(rows.length, 3)
      assert.match(rows[0], /A ok/)
      assert.match(rows[1], /B bad/)
      assert.match(rows[1], /json \$\.path: expected == "\/nope", got "\/b"/)
      assert.match(rows[2], /Streaming request, not run/)
      assert.ok(!rows.some((r) => r.includes('Outside')))

      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await page.getByRole('button', { name: 'Run all requests' }).click()
      await page.getByText(/Finished: 2 passed, 1 failed, 1 skipped of 4/).waitFor({ timeout: 10000 })
      assert.deepEqual(pageErrors, [])
    }
  )
})
