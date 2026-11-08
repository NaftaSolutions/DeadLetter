import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyAuth, detectAuth } from './auth.ts'
import { removeHeader, upsertHeader } from './headers.ts'
import {
  detectBodyMode,
  boundaryOf,
  parseGraphql,
  parseMultipart,
  parseUrlencoded,
  serializeGraphql,
  serializeMultipart,
  serializeUrlencoded
} from './requestBody.ts'
import { newRow, type KeyValue } from './request.ts'
import { entryPassed, isStreamUrl, requestsUnder, summarize } from './runner.ts'
import { connecting, idleStream, MAX_ENTRIES, reduceStream, streamKind } from './stream.ts'
import type { StreamEvent } from '@shared/api'

const row = (name: string, value: string, enabled = true): KeyValue => ({ ...newRow(), name, value, enabled })
const pairs = (hs: KeyValue[]): string[][] => hs.map((h) => [h.name, h.value])

test('headers: upsert replaces in place or inserts on top, remove keeps a blank row', () => {
  const hs = [row('Accept', '*/*'), newRow()]
  assert.deepEqual(pairs(upsertHeader(hs, 'authorization', 'x')).slice(0, 2), [['authorization', 'x'], ['Accept', '*/*']])
  const re = upsertHeader([row('Authorization', 'old', false)], 'Authorization', 'new')
  assert.deepEqual([re[0]?.value, re[0]?.enabled], ['new', true])
  const removed = removeHeader([row('Authorization', 'x')], 'authorization')
  assert.equal(removed.length, 1)
  assert.equal(removed[0]?.name, '')
})

test('auth: bearer and basic round-trip through the Authorization header', () => {
  const bearer = applyAuth([newRow()], { kind: 'bearer', token: '{{token}}', username: '', password: '' })
  assert.equal(bearer[0]?.value, 'Bearer {{token}}')
  assert.deepEqual(detectAuth(bearer), { kind: 'bearer', token: '{{token}}', username: '', password: '' })

  const basic = applyAuth([newRow()], { kind: 'basic', token: '', username: 'ada', password: 'p:w d' })
  assert.equal(basic[0]?.value, 'Basic ada:p:w d')
  const back = detectAuth(basic)
  assert.deepEqual([back.kind, back.username, back.password], ['basic', 'ada', 'p:w d'])
})

test('auth: other schemes are left alone, none removes the header', () => {
  const digest = [row('Authorization', 'Digest abc')]
  assert.equal(detectAuth(digest).kind, 'custom')
  assert.equal(applyAuth(digest, { kind: 'custom', token: '', username: '', password: '' }), digest)
  assert.equal(detectAuth([row('Authorization', 'Basic dXNlcjpwYXNz')]).kind, 'custom')
  assert.equal(detectAuth([row('Authorization', 'Bearer x', false)]).kind, 'none')
  assert.equal(detectAuth([newRow()]).kind, 'none')
  assert.equal(applyAuth(digest, { kind: 'none', token: '', username: '', password: '' })[0]?.name, '')
})

test('urlencoded: encodes values but keeps {{placeholders}} readable', () => {
  const body = serializeUrlencoded([
    { name: 'q', value: 'a b&c' },
    { name: 'token', value: '{{token}}' },
    { name: '', value: '' }
  ])
  assert.equal(body, 'q=a%20b%26c&token={{token}}')
  assert.deepEqual(parseUrlencoded(body), [
    { name: 'q', value: 'a b&c' },
    { name: 'token', value: '{{token}}' }
  ])
  assert.deepEqual(parseUrlencoded('a=1+2&flag&bad=%E0%A4'), [
    { name: 'a', value: '1 2' },
    { name: 'flag', value: '' },
    { name: 'bad', value: '%E0%A4' }
  ])
})

test('graphql: envelope detection and serialization', () => {
  const body = serializeGraphql({ query: '{ me { id } }', variables: '{"id": 1}' })
  assert.ok(body.ok)
  assert.deepEqual(parseGraphql(body.ok ? body.body : ''), { query: '{ me { id } }', variables: '{\n  "id": 1\n}' })
  assert.equal(parseGraphql('{"query":"x","extra":1}'), null)
  assert.equal(parseGraphql('{"query":1}'), null)
  assert.equal(parseGraphql('[1]'), null)
  assert.equal(parseGraphql('nope'), null)

  const noVars = serializeGraphql({ query: 'q', variables: '  ' })
  assert.deepEqual(noVars, { ok: true, body: '{\n  "query": "q"\n}' })
  assert.equal(serializeGraphql({ query: 'q', variables: '{bad' }).ok, false)
  assert.equal(serializeGraphql({ query: 'q', variables: '[1]' }).ok, false)
})

test('multipart: text fields round-trip, files and malformed bodies stay raw', () => {
  const fields = [
    { name: 'a', value: '1' },
    { name: 'note', value: 'line1\nline2 {{x}}' },
    { name: 'q"uote', value: '' }
  ]
  const body = serializeMultipart(fields)
  assert.equal(boundaryOf('multipart/form-data; boundary="xyz"; charset=utf-8'), 'xyz')
  assert.equal(boundaryOf('multipart/form-data'), null)
  assert.deepEqual(parseMultipart(body, '----DeadLetterFormBoundary'), fields)
  assert.equal(parseMultipart(body.replace(/\n/g, '\r\n'), '----DeadLetterFormBoundary')?.length, 3)
  const file = '--b\nContent-Disposition: form-data; name="f"; filename="x.png"\n\nBIN\n--b--\n'
  assert.equal(parseMultipart(file, 'b'), null)
  assert.equal(parseMultipart('--b\nContent-Disposition: form-data; name="a"\n\n1\n', 'b'), null)
  assert.equal(parseMultipart('nope', 'b'), null)
  assert.equal(serializeMultipart([]), '------DeadLetterFormBoundary--\n')
})

test('multipart: file fields are `< path` references that round-trip', () => {
  const fields = [
    { name: 'a', value: '1' },
    { name: 'avatar', value: '< C:\\pics\\me.png' },
    { name: 'doc', value: '< /home/u/a b.pdf' },
    { name: 'rel', value: '< ./uploads/a.png' },
    { name: 'text', value: '< not-a-path' }
  ]
  const body = serializeMultipart(fields, 'b')
  assert.match(body, /name="avatar"; filename="me.png"\n\n< C:\\pics\\me.png\n/)
  assert.match(body, /name="rel"; filename="a.png"\n\n< \.\/uploads\/a\.png\n/)
  assert.match(body, /name="text"\n\n< not-a-path\n/) // not path-shaped: stays a text field
  assert.deepEqual(parseMultipart(body, 'b'), fields)
})

test('body mode is derived from Content-Type and body shape', () => {
  assert.equal(detectBodyMode([row('Content-Type', 'application/x-www-form-urlencoded; charset=utf-8')], ''), 'urlencoded')
  assert.equal(detectBodyMode([row('Content-Type', 'application/json')], '{"query":"{ a }"}'), 'graphql')
  assert.equal(detectBodyMode([newRow()], '{"query":"{ a }"}'), 'graphql')
  assert.equal(detectBodyMode([row('Content-Type', 'application/json')], '{"a":1}'), 'raw')
  assert.equal(detectBodyMode([row('Content-Type', 'text/plain')], '{"query":"x"}'), 'raw')
  assert.equal(detectBodyMode([newRow()], ''), 'raw')
  const mp = row('Content-Type', 'multipart/form-data; boundary=----DeadLetterFormBoundary')
  assert.equal(detectBodyMode([mp], serializeMultipart([{ name: 'a', value: '1' }])), 'multipart')
  assert.equal(detectBodyMode([mp], ''), 'multipart')
  assert.equal(detectBodyMode([mp], '--other\nwhatever'), 'raw')
})

test('streams: kind detection and event log reduction', () => {
  const draft = (url: string, headers: KeyValue[] = []) => ({ url, headers })
  assert.equal(streamKind(draft('wss://x.test/socket')), 'ws')
  assert.equal(streamKind(draft('https://x.test', [row('Accept', 'text/event-stream')])), 'sse')
  assert.equal(streamKind(draft('https://x.test', [row('Accept', 'text/event-stream', false)])), null)
  assert.equal(streamKind(draft('https://x.test')), null)

  const ev = (e: Partial<StreamEvent> & { kind: string }): StreamEvent => ({ id: 1, atMs: 5, ...e })
  let s = connecting()
  s = reduceStream(s, ev({ kind: 'open', status: 200, statusText: 'OK', headers: [] }))
  s = reduceStream(s, ev({ kind: 'message', data: 'hi', event: 'tick' }))
  s = reduceStream(s, ev({ kind: 'close', data: 'Disconnected' }))
  assert.deepEqual([s.phase, s.status?.code, s.entries.map((e) => e.kind)], ['closed', 200, ['info', 'message', 'info']])
  assert.equal(s.entries[1]?.event, 'tick')

  let busy = idleStream()
  for (let i = 0; i < MAX_ENTRIES + 3; i++) busy = reduceStream(busy, ev({ kind: 'message', data: String(i) }))
  assert.deepEqual([busy.entries.length, busy.dropped, busy.entries[0]?.data], [MAX_ENTRIES, 3, '3'])
})

test('runner: requests under a folder in sidebar order, and run summaries', () => {
  const req = (path: string) => ({ path, name: path.split('/').pop()!, kind: 'request', format: 'http', method: 'GET' })
  const folder = (path: string) => ({ path, name: path.split('/').pop()!, kind: 'folder' })
  const nodes = [req('z.http'), folder('b'), req('b/two.http'), req('b/one.http'), folder('b/inner'), req('b/inner/x.http'), folder('a'), req('a/y.http')]
  assert.deepEqual(requestsUnder(nodes, '').map((n) => n.path), ['a/y.http', 'b/inner/x.http', 'b/one.http', 'b/two.http', 'z.http'])
  assert.deepEqual(requestsUnder(nodes, 'b').map((n) => n.path), ['b/inner/x.http', 'b/one.http', 'b/two.http'])
  assert.deepEqual(requestsUnder(nodes, 'b/inner').map((n) => n.path), ['b/inner/x.http'])
  assert.deepEqual(requestsUnder(nodes, 'nope'), [])
  const ok = { path: 'a', name: 'a', method: 'GET', tests: [{ assertion: 's', passed: true, message: '' }] }
  const bad = { ...ok, tests: [{ assertion: 's', passed: false, message: 'no' }] }
  assert.ok(entryPassed(ok) && !entryPassed(bad) && !entryPassed({ ...ok, error: 'boom' }))
  assert.deepEqual(summarize([ok, bad, { ...ok, skipped: true, error: 's' }]), { total: 3, passed: 1, failed: 1, skipped: 1 })
  assert.ok(isStreamUrl('wss://x') && isStreamUrl(' ws://x') && !isStreamUrl('https://x'))
})
