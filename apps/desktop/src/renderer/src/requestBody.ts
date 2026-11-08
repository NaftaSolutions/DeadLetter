// Body modes are a view over the body text plus the Content-Type header, so files remain
// plain .http/.json: a urlencoded body is `a=1&b=2`, a multipart body is the usual boundary-
// delimited text, a GraphQL body is the usual JSON envelope.

import { findHeader } from './headers.ts'
import type { KeyValue } from './request.ts'

export type BodyMode = 'raw' | 'urlencoded' | 'multipart' | 'graphql'

export const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'
export const JSON_CONTENT_TYPE = 'application/json'
export const MULTIPART_BOUNDARY = '----DeadLetterFormBoundary'
export const MULTIPART_CONTENT_TYPE = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`

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
  const raw = findHeader(headers, 'content-type')?.value ?? ''
  const type = raw.toLowerCase()
  if (type.startsWith(FORM_CONTENT_TYPE)) return 'urlencoded'
  if (type.startsWith('multipart/form-data')) {
    const boundary = boundaryOf(raw) // boundaries are case-sensitive

    // Only text-field bodies are editable as a table; a body with files stays raw text.
    if (boundary && (!body.trim() || parseMultipart(body, boundary))) return 'multipart'
  }
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

/** The `boundary=` of a multipart Content-Type value. */
export function boundaryOf(contentType: string): string | null {
  const m = /;\s*boundary="?([^";]+)"?/i.exec(contentType)
  return m?.[1] ?? null
}

const LF = '\n'

// A file field's value is `< path` (the .http convention); the engine reads the file at send time.
// Absolute paths, or `./` paths relative to the workspace.
const FILE_VALUE = /^< ((?:\/|\.[\\/]|[A-Za-z]:[\\/]|\\\\).*)$/

export const fileValue = (path: string): string => `< ${path}`

/** The path a file field points at, or null for a text field. */
export function filePathOf(value: string): string | null {
  return FILE_VALUE.exec(value.trim())?.[1] ?? null
}

/** `.http`-style multipart body (plain line feeds; the engine sends CRLF). */
export function serializeMultipart(fields: Field[], boundary = MULTIPART_BOUNDARY): string {
  const parts = fields
    .filter((f) => f.name.trim())
    .map((f) => {
      const name = f.name.replace(/"/g, '%22')
      const path = filePathOf(f.value)
      if (path === null) {
        return `--${boundary}${LF}Content-Disposition: form-data; name="${name}"${LF}${LF}${f.value}${LF}`
      }
      const filename = (path.split(/[\\/]/).pop() ?? 'file').replace(/"/g, '%22')
      return `--${boundary}${LF}Content-Disposition: form-data; name="${name}"; filename="${filename}"${LF}${LF}${fileValue(path)}${LF}`
    })
  return `${parts.join('')}--${boundary}--${LF}`
}

/** Fields of a multipart body (files as `< path`), or null if it has inline file bytes or is not well-formed. */
export function parseMultipart(body: string, boundary: string): Field[] | null {
  const fields: Field[] = []
  let closed = false
  for (const chunk of body.replace(/\r\n/g, LF).split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) {
      closed = true
      break
    }
    if (!chunk.startsWith(LF)) return null
    const sep = chunk.indexOf(LF + LF)
    if (sep === -1) return null
    const disposition = chunk
      .slice(1, sep)
      .split(LF)
      .find((l) => l.toLowerCase().startsWith('content-disposition:'))
    if (!disposition) return null
    const name = /[; ]name="([^"]*)"/.exec(disposition)?.[1]
    if (name === undefined) return null
    const raw = chunk.slice(sep + 2)
    const value = raw.endsWith(LF) ? raw.slice(0, -1) : raw
    // A part with a filename is only editable as a table when its content is a file reference.
    if (/filename=/i.test(disposition) && filePathOf(value) === null) return null
    fields.push({ name: name.replace(/%22/g, '"'), value })
  }
  return closed ? fields : null
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
