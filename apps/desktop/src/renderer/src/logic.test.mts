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
