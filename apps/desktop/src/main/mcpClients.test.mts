import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addServer, claudeAddArgs, configPath, hasServer, removeServer } from './mcpClients.ts'

const ep = { url: 'http://127.0.0.1:39217/mcp', token: 'tok' }
const text = (e: ReturnType<typeof addServer>): string => {
  assert.ok(e.ok, e.ok ? '' : e.reason)
  return e.text
}

test('creates the file content when there is none', () => {
  const cursor = JSON.parse(text(addServer(null, 'cursor', ep)))
  assert.deepEqual(cursor, { mcpServers: { deadletter: { url: ep.url, headers: { Authorization: 'Bearer tok' } } } })
  const vscode = JSON.parse(text(addServer('  ', 'vscode', ep)))
  assert.deepEqual(vscode.servers.deadletter, { type: 'http', url: ep.url, headers: { Authorization: 'Bearer tok' } })
})

test('keeps other servers and settings, and replaces a stale entry', () => {
  const before = JSON.stringify({ inputs: [1], mcpServers: { other: { url: 'x' }, deadletter: { url: 'old' } } })
  const after = JSON.parse(text(addServer(before, 'cursor', ep)))
  assert.deepEqual(after.inputs, [1])
  assert.deepEqual(after.mcpServers.other, { url: 'x' })
  assert.equal(after.mcpServers.deadletter.url, ep.url)
})

test('removing only drops the DeadLetter entry', () => {
  const installed = text(addServer(JSON.stringify({ servers: { other: { url: 'x' } } }), 'vscode', ep))
  assert.equal(hasServer(installed, 'vscode'), true)
  const removed = text(removeServer(installed, 'vscode'))
  assert.equal(hasServer(removed, 'vscode'), false)
  assert.deepEqual(JSON.parse(removed), { servers: { other: { url: 'x' } } })
})

test('refuses files it could damage', () => {
  for (const bad of ['{ // comment\n}', '{"a":1,}', '[]', '"x"', '{"mcpServers": []}']) {
    const edit = addServer(bad, 'cursor', ep)
    assert.equal(edit.ok, false, bad)
  }
  assert.equal(hasServer('{nope', 'cursor'), false)
})

test('config locations per platform', () => {
  assert.equal(configPath('cursor', 'win32', 'C:\\u', undefined).replaceAll('\\', '/'), 'C:/u/.cursor/mcp.json')
  assert.equal(configPath('vscode', 'win32', 'C:\\u', 'C:\\u\\AppData\\Roaming').replaceAll('\\', '/'), 'C:/u/AppData/Roaming/Code/User/mcp.json')
  assert.equal(configPath('vscode', 'darwin', '/Users/u', undefined).replaceAll('\\', '/'), '/Users/u/Library/Application Support/Code/User/mcp.json')
})

test('claude add uses user scope and a Name: value header', () => {
  const args = claudeAddArgs(ep)
  assert.deepEqual(args.slice(0, 7), ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'deadletter'])
  assert.equal(args.at(-1), 'Authorization: Bearer tok')
})
