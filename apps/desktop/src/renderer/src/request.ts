import type { HeaderEntry, RequestPayload } from '@shared/api'

export const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const
export type Method = (typeof METHODS)[number]

export interface KeyValue {
  id: string
  enabled: boolean
  name: string
  value: string
}

export interface RequestDraft {
  method: Method
  url: string
  headers: KeyValue[]
  body: string
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