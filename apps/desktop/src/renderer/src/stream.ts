import type { HeaderEntry, StreamEvent, StreamKind } from '@shared/api'
import type { RequestDraft } from './request'

/** Kept in memory per session; older entries are dropped so a chatty stream cannot exhaust the renderer. */
export const MAX_ENTRIES = 5000

/** WebSocket by URL scheme, SSE by an enabled `Accept: text/event-stream` header; otherwise a plain request. */
export function streamKind(draft: Pick<RequestDraft, 'url' | 'headers'>): StreamKind | null {
  if (/^\s*wss?:\/\//i.test(draft.url)) return 'ws'
  const sse = draft.headers.some(
    (h) => h.enabled && h.name.trim().toLowerCase() === 'accept' && h.value.toLowerCase().includes('text/event-stream')
  )
  return sse ? 'sse' : null
}

export interface LogEntry {
  key: number
  kind: 'message' | 'sent' | 'error' | 'info'
  atMs: number
  /** SSE event name. */
  event?: string
  eventId?: string
  data: string
  binary?: boolean
}

export interface StreamState {
  phase: 'idle' | 'connecting' | 'open' | 'closed'
  status?: { code: number; text: string }
  headers: HeaderEntry[]
  entries: LogEntry[]
  /** Number of entries dropped from the front once `MAX_ENTRIES` was exceeded. */
  dropped: number
  nextKey: number
}

export const idleStream = (): StreamState => ({ phase: 'idle', headers: [], entries: [], dropped: 0, nextKey: 0 })

export const connecting = (): StreamState => ({ ...idleStream(), phase: 'connecting' })

function append(state: StreamState, entry: Omit<LogEntry, 'key'>): StreamState {
  const entries = [...state.entries, { ...entry, key: state.nextKey }]
  const over = Math.max(0, entries.length - MAX_ENTRIES)
  return { ...state, entries: over ? entries.slice(over) : entries, dropped: state.dropped + over, nextKey: state.nextKey + 1 }
}

export function reduceStream(state: StreamState, e: StreamEvent): StreamState {
  const atMs = e.atMs
  switch (e.kind) {
    case 'open': {
      const code = e.status ?? 0
      const text = e.statusText ?? ''
      const next: StreamState = { ...state, phase: 'open', status: { code, text }, headers: e.headers ?? [] }
      return append(next, { kind: 'info', atMs, data: `Connected${code ? ` (${code} ${text})`.trimEnd() : ''}` })
    }
    case 'message':
    case 'sent':
      return append(state, {
        kind: e.kind,
        atMs,
        event: e.event ?? undefined,
        eventId: e.eventId ?? undefined,
        data: e.data ?? '',
        binary: e.binary ?? undefined
      })
    case 'error':
      return append(state, { kind: 'error', atMs, data: e.data ?? 'Unknown error' })
    case 'close':
      return append({ ...state, phase: 'closed' }, { kind: 'info', atMs, data: e.data ?? 'Disconnected' })
    default:
      return state
  }
}
