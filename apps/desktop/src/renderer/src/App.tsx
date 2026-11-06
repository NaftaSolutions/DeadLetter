import { useCallback, useEffect, useRef, useState } from 'react'
import { RequestBar } from './components/RequestBar'
import { RequestPane } from './components/RequestPane'
import { ResponsePane } from './components/ResponsePane'
import { StatusBadge, type EngineStatus } from './StatusBadge'
import { newRow, type RequestDraft } from './request'
import { useSend } from './useSend'

const initialDraft = (): RequestDraft => ({ method: 'GET', url: '', headers: [newRow()], body: '' })

export function App() {
  const [engine, setEngine] = useState<EngineStatus>({ state: 'loading' })
  const [draft, setDraft] = useState<RequestDraft>(initialDraft)
  const { state, send } = useSend()

  useEffect(() => {
    window.deadletter
      .ping()
      .then((message) => setEngine({ state: 'ok', message }))
      .catch((e: unknown) => setEngine({ state: 'error', message: String(e) }))
  }, [])

  const patch = useCallback((p: Partial<RequestDraft>) => setDraft((d) => ({ ...d, ...p })), [])

  // Global Cmd/Ctrl+Enter, wherever focus is (including inside the body textarea).
  const sendRef = useRef(() => {})
  sendRef.current = () => {
    if (state.kind !== 'loading') void send(draft)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        sendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">DeadLetter</span>
        <StatusBadge status={engine} />
      </header>
      <RequestBar
        method={draft.method}
        url={draft.url}
        loading={state.kind === 'loading'}
        onMethod={(method) => patch({ method })}
        onUrl={(url) => patch({ url })}
        onSend={() => sendRef.current()}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        <RequestPane draft={draft} onChange={patch} />
        <ResponsePane state={state} />
      </main>
    </div>
  )
}