import { useEffect, useState } from 'react'
import { StatusBadge, type EngineStatus } from './StatusBadge'

export function App() {
  const [status, setStatus] = useState<EngineStatus>({ state: 'loading' })

  useEffect(() => {
    window.deadletter
      .ping()
      .then((message) => setStatus({ state: 'ok', message }))
      .catch((e: unknown) => setStatus({ state: 'error', message: String(e) }))
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight">DeadLetter</span>
        <StatusBadge status={status} />
      </header>
      <main className="flex flex-1 items-center justify-center text-sm text-zinc-600">
        No request selected
      </main>
    </div>
  )
}