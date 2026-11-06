import type { HeaderEntry, RequestFile, RequestPayload } from '@shared/api'

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type Method = (typeof METHODS)[number]

export interface KeyValue {
  id: string
  enabled: boolean
  name: string
  value: string
}

export interface RequestDraft {
  /** Display name; the sidebar renames it together with the file. */
  name: string
  method: Method
  url: string
  headers: KeyValue[]
  body: string
}

export const emptyDraft = (): RequestDraft => ({
  name: '',
  method: 'GET',
  url: '',
  headers: [newRow()],
  body: ''
})

export function fromFile(f: RequestFile): RequestDraft {
  return {
    name: f.name,
    method: f.method.toUpperCase() as Method,
    url: f.url,
    headers: [...f.headers.map((h) => ({ id: crypto.randomUUID(), ...h })), newRow()],
    body: f.body ?? ''
  }
}

/** What gets written to disk: no ids, no trailing empty editor row. */
export function toFile(d: RequestDraft): RequestFile {
  return {
    name: d.name,
    method: d.method,
    url: d.url,
    headers: d.headers
      .filter((h) => h.name.trim() || h.value.trim())
      .map(({ name, value, enabled }) => ({ name, value, enabled })),
    body: d.body.length > 0 ? d.body : undefined
  }
}

export const newRow = (): KeyValue => ({ id: crypto.randomUUID(), enabled: true, name: '', value: '' })

/** Adds a scheme when the user typed a bare host, e.g. `localhost:3000/api`. */
function normalizeUrl(raw: string): string {
  const url = raw.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`
}

export function toPayload(d: RequestDraft): RequestPayload {
  const headers: HeaderEntry[] = d.headers
    .filter((h) => h.enabled && h.name.trim())
    .map(({ name, value }) => ({ name, value }))

  const hasBody = d.body.trim().length > 0
  const hasContentType = headers.some((h) => h.name.trim().toLowerCase() === 'content-type')
  if (hasBody && !hasContentType && /^\s*[{[]/.test(d.body)) {
    headers.push({ name: 'Content-Type', value: 'application/json' })
  }

  return { method: d.method, url: normalizeUrl(d.url), headers, body: hasBody ? d.body : undefined }
}