// Auth helpers are a view over the `Authorization` header, so request files stay plain,
// portable .http/.json: nothing new is stored. Basic credentials are written as
// `Basic user:pass` and base64-encoded by the engine at send time (REST Client / JetBrains style).

import { findHeader, removeHeader, upsertHeader } from './headers.ts'
import type { KeyValue } from './request.ts'

export type AuthKind = 'none' | 'bearer' | 'basic' | 'custom'

export interface Auth {
  kind: AuthKind
  token: string
  username: string
  password: string
}

export const noAuth = (): Auth => ({ kind: 'none', token: '', username: '', password: '' })

/** `custom` means an Authorization header the helpers cannot edit (Digest, raw base64, ...). */
export function detectAuth(headers: KeyValue[]): Auth {
  const h = findHeader(headers, 'authorization')
  if (!h || !h.value.trim()) return noAuth()
  const value = h.value.trim()
  const [scheme = '', ...restParts] = value.split(/\s+/)
  const rest = value.slice(scheme.length).trim()
  if (scheme.toLowerCase() === 'bearer') return { ...noAuth(), kind: 'bearer', token: restParts.join(' ') }
  if (scheme.toLowerCase() === 'basic') {
    if (rest.includes(':')) {
      const i = rest.indexOf(':')
      return { ...noAuth(), kind: 'basic', username: rest.slice(0, i), password: rest.slice(i + 1) }
    }
    if (restParts.length === 0) return { ...noAuth(), kind: 'basic' }
  }
  return { ...noAuth(), kind: 'custom' }
}

/** Writes `auth` into the headers. `custom` leaves them alone. */
export function applyAuth(headers: KeyValue[], auth: Auth): KeyValue[] {
  switch (auth.kind) {
    case 'bearer':
      return upsertHeader(headers, 'Authorization', `Bearer ${auth.token}`)
    case 'basic':
      return upsertHeader(headers, 'Authorization', `Basic ${auth.username}:${auth.password}`)
    case 'none':
      return removeHeader(headers, 'Authorization')
    default:
      return headers
  }
}
