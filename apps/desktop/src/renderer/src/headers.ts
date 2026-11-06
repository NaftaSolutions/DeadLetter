import { newRow, type KeyValue } from './request.ts'

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

export function findHeader(headers: KeyValue[], name: string): KeyValue | undefined {
  return headers.find((h) => h.enabled && same(h.name, name))
}

/**
 * Sets the first matching header (re-enabling it), or inserts one at the top of the table.
 * Keeps the editor's trailing blank row last.
 */
export function upsertHeader(headers: KeyValue[], name: string, value: string): KeyValue[] {
  const i = headers.findIndex((h) => same(h.name, name))
  if (i === -1) return [{ ...newRow(), name, value }, ...headers]
  return headers.map((h, idx) => (idx === i ? { ...h, name, value, enabled: true } : h))
}

/** Removes every header with that name; always leaves at least the blank editor row. */
export function removeHeader(headers: KeyValue[], name: string): KeyValue[] {
  const next = headers.filter((h) => !same(h.name, name))
  return next.length ? next : [newRow()]
}
