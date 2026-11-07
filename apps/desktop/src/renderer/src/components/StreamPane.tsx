import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, CircleAlert, Info, SendHorizontal, Trash2 } from 'lucide-react'
import type { StreamKind } from '@shared/api'
import type { LogEntry, StreamState } from '../stream'

interface Props {
  kind: StreamKind
  state: StreamState
  onSend: (text: string) => Promise<boolean>
  onClear: () => void
}

const time = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`)

const PHASE: Record<StreamState['phase'], { label: string; tone: string }> = {
  idle: { label: 'Not connected', tone: 'text-zinc-500' },
  connecting: { label: 'Connecting…', tone: 'text-amber-300' },
  open: { label: 'Connected', tone: 'text-emerald-300' },
  closed: { label: 'Disconnected', tone: 'text-zinc-400' }
}

const ICONS = { sent: ArrowUp, message: ArrowDown, error: CircleAlert, info: Info } as const
const TONES = { sent: 'text-sky-300', message: 'text-zinc-200', error: 'text-red-300', info: 'text-zinc-500' } as const

function Row({ entry }: { entry: LogEntry }) {
  const Icon = ICONS[entry.kind]
  return (
    <li className={`flex gap-2 border-b border-zinc-900 px-3 py-1.5 font-mono text-xs ${TONES[entry.kind]}`}>
      <Icon aria-label={entry.kind} className="mt-0.5 size-3.5 shrink-0 opacity-70" />
      <span className="w-14 shrink-0 text-right text-zinc-600">{time(entry.atMs)}</span>
      <div className="min-w-0 flex-1">
        {(entry.event || entry.eventId) && (
          <div className="mb-0.5 flex gap-2 text-[11px] text-zinc-500">
            {entry.event && <span className="rounded border border-zinc-800 px-1">{entry.event}</span>}
            {entry.eventId && <span>id {entry.eventId}</span>}
          </div>
        )}
        <pre className="whitespace-pre-wrap break-all font-mono">
          {entry.data || <span className="text-zinc-600">(empty)</span>}
        </pre>
      </div>
    </li>
  )
}

export const StreamPane = memo(function StreamPane({ kind, state, onSend, onClear }: Props) {
  const [draft, setDraft] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const phase = PHASE[state.phase]

  // Follow the tail unless the user scrolled up to read.
  useEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [state.entries])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft || state.phase !== 'open') return
    if (await onSend(draft)) setDraft('')
  }

  const emptyHint =
    state.phase === 'idle'
      ? kind === 'ws'
        ? 'Press Connect to open the socket'
        : 'Press Connect to start streaming'
      : 'Waiting for events…'

  return (
    <section aria-label="Stream" className="flex min-h-0 flex-1 flex-col border-t border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs">
        <div className="flex items-center gap-3 font-mono">
          <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-zinc-400">
            {kind === 'ws' ? 'WebSocket' : 'SSE'}
          </span>
          <span className={phase.tone} role="status">
            {phase.label}
          </span>
          {state.status && (
            <span className="text-zinc-500">
              {state.status.code} {state.status.text}
            </span>
          )}
          <span className="text-zinc-600">{state.entries.length + state.dropped} entries</span>
        </div>
        <button
          type="button"
          onClick={onClear}
          disabled={state.entries.length === 0}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        >
          <Trash2 className="size-3.5" />
          Clear
        </button>
      </div>

      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        {state.entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-600">{emptyHint}</div>
        ) : (
          <ul aria-label="Stream log">
            {state.dropped > 0 && (
              <li className="px-3 py-1.5 text-center text-[11px] text-zinc-600">{state.dropped} older entries dropped</li>
            )}
            {state.entries.map((e) => (
              <Row key={e.key} entry={e} />
            ))}
          </ul>
        )}
      </div>

      {kind === 'ws' && (
        <form onSubmit={submit} className="flex gap-2 border-t border-zinc-800 p-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={state.phase !== 'open'}
            placeholder={state.phase === 'open' ? 'Message to send ({{variables}} work here too)' : 'Connect to send messages'}
            aria-label="Message to send"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 hover:border-zinc-700 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!draft || state.phase !== 'open'}
            className="flex h-8 items-center gap-2 rounded-md bg-zinc-100 px-3 text-xs font-semibold text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            <SendHorizontal className="size-3.5" />
            Send
          </button>
        </form>
      )}
    </section>
  )
})
