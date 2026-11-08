import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { test } from 'node:test'
import { eventually, withApp } from './harness.mts'

/** Minimal server: an SSE endpoint, and a WebSocket endpoint that echoes text frames as `echo: <text>`. */
async function startServer(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    if (req.url !== '/events') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(': hello\n\n')
    res.write('event: greeting\nid: 1\ndata: first\n\n')
    res.write('data: line one\ndata: line two\n\n')
    // Never ends: the client has to stop the stream.
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const frame = (text: string): Buffer => {
      const body = Buffer.from(text)
      return Buffer.concat([Buffer.from([0x81, body.length]), body]) // short frames only
    }
    socket.on('error', () => {})
    socket.write(frame('welcome'))
    socket.on('data', (buf: Buffer) => {
      const opcode = buf[0] & 0x0f
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]))
        return
      }
      const len = buf[1] & 0x7f
      const mask = buf.subarray(2, 6)
      const payload = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]))
      socket.write(frame(`echo: ${payload.toString()}`))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as AddressInfo).port, sockets }
}

test('SSE: an Accept: text/event-stream request streams events until stopped', async () => {
  const { server, port, sockets } = await startServer()
  try {
    const files = {
      's.http': `### S\nGET http://127.0.0.1:${port}/events\nAccept: text/event-stream\n`
    }
    await withApp({ files }, async ({ page, shot, pageErrors }) => {
      await page.locator('button[title="s.http"]').click()
      const connect = page.getByRole('button', { name: /^Connect/ })
      await connect.click()

      const log = page.getByRole('list', { name: 'Stream log' })
      await log.getByText('first', { exact: true }).waitFor()
      await log.getByText('greeting', { exact: true }).waitFor()
      await log.getByText(/line one\s*line two/).waitFor()
      await page.getByRole('status').getByText('Connected').waitFor()
      await shot('20-sse')

      await page.getByRole('button', { name: /^Stop/ }).click()
      await page.getByRole('status').getByText('Disconnected').waitFor()
      await log.getByText('Disconnected', { exact: true }).waitFor()
      assert.deepEqual(pageErrors, [])
    })
  } finally {
    sockets.forEach((s) => s.destroy())
    server.close()
  }
})

test('WebSocket: connect, receive, send and disconnect', async () => {
  const { server, port, sockets } = await startServer()
  try {
    const files = { 'w.http': `### W\nGET ws://127.0.0.1:${port}/socket\n` }
    await withApp({ files }, async ({ page, shot, pageErrors }) => {
      await page.locator('button[title="w.http"]').click()
      const send = page.getByLabel('Message to send')
      assert.equal(await send.isDisabled(), true)

      await page.getByRole('button', { name: /^Connect/ }).click()
      const log = page.getByRole('list', { name: 'Stream log' })
      await log.getByText('welcome', { exact: true }).waitFor()

      await eventually(async () => send.isEnabled(), 'message box enabled once connected')
      await send.fill('ping')
      await send.press('Enter')
      await log.getByText('echo: ping', { exact: true }).waitFor()
      await log.getByText('ping', { exact: true }).waitFor()
      assert.equal(await send.inputValue(), '')
      await shot('21-websocket')

      await page.getByRole('button', { name: /^Stop/ }).click()
      await page.getByRole('status').getByText('Disconnected').waitFor()
      assert.equal(await send.isDisabled(), true)

      await page.getByRole('button', { name: 'Clear' }).click()
      assert.equal(await log.count(), 0)
      assert.deepEqual(pageErrors, [])
    })
  } finally {
    sockets.forEach((s) => s.destroy())
    server.close()
  }
})

test('WebSocket: an unreachable server reports the failure and stays usable', async () => {
  await withApp({ files: { 'w.http': '### W\nGET ws://127.0.0.1:1/nope\n' } }, async ({ page, pageErrors }) => {
    await page.locator('button[title="w.http"]').click()
    await page.getByRole('button', { name: /^Connect/ }).click()
    await page.getByText(/Connection failed/).first().waitFor()
    await page.getByRole('status').getByText('Disconnected').waitFor()
    await page.getByRole('button', { name: /^Connect/ }).waitFor()
    assert.deepEqual(pageErrors, [])
  })
})

test('WebSocket requests have no Body tab, and a bare scheme gets a clear error', async () => {
  await withApp({ files: { 'w.http': '### W\nGET ws://\n' } }, async ({ page, pageErrors }) => {
    await page.locator('button[title="w.http"]').click()
    await eventually(async () => (await page.getByLabel('Request URL').inputValue()) === 'ws://', 'request opened')
    const tabs = page.getByRole('tablist', { name: 'request' })
    await tabs.getByRole('tab', { name: /^Headers/ }).waitFor()
    assert.equal(await tabs.getByRole('tab', { name: /^Body/ }).count(), 0)
    await page.getByRole('button', { name: /^Connect/ }).click()
    await page.getByText(/Enter a host after the scheme/).first().waitFor()
    // An ordinary request keeps its Body tab.
    await page.getByLabel('Request URL').fill('http://x.test')
    await tabs.getByRole('tab', { name: /^Body/ }).waitFor()
    assert.deepEqual(pageErrors, [])
  })
})
