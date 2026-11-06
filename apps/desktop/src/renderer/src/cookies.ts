import type { HeaderEntry } from '@shared/api'

export interface Cookie {
  name: string
  value: string
  /** Remaining attributes, e.g. `Path=/`, `HttpOnly`, `Max-Age=3600`. */
  attributes: string[]
}

/** Parses every `Set-Cookie` header of a response (the engine keeps duplicates). */
export function parseSetCookies(headers: HeaderEntry[]): Cookie[] {
  return headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => {
      const [pair = '', ...attrs] = h.value.split(';').map((s) => s.trim())
      const eq = pair.indexOf('=')
      return {
        name: eq === -1 ? pair : pair.slice(0, eq),
        value: eq === -1 ? '' : pair.slice(eq + 1),
        attributes: attrs.filter(Boolean)
      }
    })
    .filter((c) => c.name)
}
