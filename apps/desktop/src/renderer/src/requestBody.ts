// Body modes are a view over the body text plus the Content-Type header, so files remain
// plain .http/.json: a urlencoded body is `a=1&b=2`, a GraphQL body is the usual JSON envelope.

import { findHeader } from './headers.ts'
import type { KeyValue } from './request.ts'

export type BodyMode = 'raw' | 'urlencoded' | 'graphql'

export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'
export const JSON_CONTENT_TYPE = 'application/json'

export interface Field {
  name: string
  value: string
}

export interface GraphqlBody {
  query: string
  /** JSON text as typed; may be empty or (while editing) invalid. */
  variables: string
}

export function detectBodyMode(headers: KeyValue[], body: string): BodyMode {
  const type = findHeader(headers, 'content-type')?.value.toLowerCase() ?? ''
  if (type.startsWith(FORM_CONTENT_TYPE)) return 'urlencoded'
  if (body.trim() && (!type || type.includes('json')) && parseGraphql(body)) return 'graphql'
  return 'raw'
}

// `{{variable}}` placeholders must survive encoding; the engine encodes their values at send time.
const PLACEHOLDER = /(\{\{[^}]*\}\})/

const encode = (s: string): string =>
  s
    .split(PLACEHOLDER)
    .map((part, i) => (i % 2 === 1 ? part : encodeURIComponent(part)))
    .join('')

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

export function parseUrlencoded(body: string): Field[] {
  return body
    .split('&')
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const eq = pair.indexOf('=')
      return eq === -1
        ? { name: decode(pair), value: '' }
        : { name: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) }
    })
}

export function serializeUrlencoded(fields: Field[]): string {
  return fields
    .filter((f) => f.name.trim() || f.value.trim())
    .map((f) => `${encode(f.name)}=${encode(f.value)}`)
    .join('&')
}

/** The body if it is a `{ "query": "...", "variables": {...} }` envelope and nothing else. */
export function parseGraphql(body: string): GraphqlBody | null {
  let v: unknown
  try {
    v = JSON.parse(body)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.query !== 'string' || Object.keys(o).some((k) => k !== 'query' && k !== 'variables')) return null
  const vars = o.variables
  if (vars === undefined || vars === null) return { query: o.query, variables: '' }
  if (typeof vars !== 'object' || Array.isArray(vars)) return null
  return { query: o.query, variables: JSON.stringify(vars, null, 2) }
}

export type GraphqlResult = { ok: true; body: string } | { ok: false; error: string }

export function serializeGraphql({ query, variables }: GraphqlBody): GraphqlResult {
  const envelope: { query: string; variables?: unknown } = { query }
  if (variables.trim()) {
    try {
      const parsed: unknown = JSON.parse(variables)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'Variables must be a JSON object' }
      }
      envelope.variables = parsed
    } catch (e) {
      return { ok: false, error: `Variables are not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { ok: true, body: JSON.stringify(envelope, null, 2) }
}
