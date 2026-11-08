import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

interface Rpc {
  result?: { isError?: boolean; content?: { text: string }[]; protocolVersion?: string }
  error?: { code: number }
}

async function rpc(url: string, token: string | null, body: unknown): Promise<{ status: number; json: Rpc | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let json: Rpc | null = null
  try {
    json = JSON.parse(text) as Rpc
  } catch {
    /* refusals are plain text */
  }
  return { status: res.status, json }
}

const sendCall = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'send_request', arguments: { path: 'ping.http' } }
})

test('mcp: off by default, opt-in from settings, token required, sends need approval', async () => {
  await withApp({}, async ({ page, ws, api, userData, pageErrors }) => {
    // A fresh install never listens: no preference file and nothing to connect to.
    assert.equal(existsSync(join(userData, 'mcp.json')), false)

    const port = 40000 + Math.floor(Math.random() * 20000)
    await page.evaluate((p) => window.deadletter.mcp.configure({ port: p }), port)
    writeFileSync(join(ws, 'ping.http'), `### Ping\nGET ${api}/pong\n`)

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Enable MCP server' }).click()
    await page.getByRole('status').filter({ hasText: 'Running on' }).waitFor()

    const status = await page.evaluate(() => window.deadletter.mcp.status())
    assert.equal(status.running, true)
    assert.equal(status.url, `http://127.0.0.1:${port}/mcp`)
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }

    assert.equal((await rpc(status.url, null, init)).status, 401)
    assert.equal((await rpc(status.url, 'wrong-token', init)).status, 401)
    const ok = await rpc(status.url, status.token, init)
    assert.equal(ok.status, 200)
    assert.equal(ok.json?.result?.protocolVersion, '2025-06-18')

    // The token lives in user-data, not in the workspace (which may be shared through git).
    assert.ok(readFileSync(join(userData, 'mcp.json'), 'utf8').includes(status.token))
    assert.equal(existsSync(join(ws, 'mcp.json')), false)

    // Reading needs no approval.
    const listed = await rpc(status.url, status.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_requests', arguments: {} }
    })
    assert.match(listed.json?.result?.content?.[0]?.text ?? '', /ping\.http/)

    // Sending waits for the user; "Allow once" releases it.
    const allowed = rpc(status.url, status.token, sendCall(3))
    const prompt = page.getByRole('dialog', { name: /AI agent wants to send/ })
    await prompt.getByText(`GET ${api}/pong`, { exact: false }).waitFor()
    await prompt.getByRole('button', { name: 'Allow once' }).click()
    const sent = await allowed
    assert.equal(sent.json?.result?.isError, false)
    assert.match(sent.json?.result?.content?.[0]?.text ?? '', /"status": 200/)

    // Denying ends the call without any network traffic.
    const denied = rpc(status.url, status.token, sendCall(4))
    await prompt.getByRole('button', { name: 'Deny' }).waitFor()
    await prompt.getByRole('button', { name: 'Deny' }).click()
    const refused = await denied
    assert.equal(refused.json?.result?.isError, true)
    assert.match(refused.json?.result?.content?.[0]?.text ?? '', /declined/)

    // Everything the agent did is visible to the user.
    const log = page.getByLabel('MCP activity')
    await log.getByText('send_request').first().waitFor()
    await log.getByText('list_requests').waitFor()

    // Turning it off closes the door again.
    await page.getByRole('button', { name: 'Disable' }).click()
    await eventually(async () => {
      try {
        await rpc(status.url, status.token, init)
        return false
      } catch {
        return true
      }
    }, 'server stopped')
    assert.deepEqual(pageErrors, [])
  })
})

test('mcp: read-only mode offers no send tool', async () => {
  await withApp({}, async ({ page }) => {
    const port = 40000 + Math.floor(Math.random() * 20000)
    await page.evaluate((p) => window.deadletter.mcp.configure({ port: p, approval: 'readonly' }), port)
    const status = await page.evaluate(() => window.deadletter.mcp.setEnabled(true))
    const listed = await fetch(status.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${status.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    }).then((r) => r.json() as Promise<{ result: { tools: { name: string }[] } }>)
    const names = listed.result.tools.map((t) => t.name)
    assert.ok(names.includes('list_requests'))
    assert.ok(!names.includes('send_request'))
  })
})
