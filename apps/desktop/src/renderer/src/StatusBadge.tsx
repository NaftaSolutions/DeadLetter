import { CircleAlert, CircleCheck, Loader } from 'lucide-react'

export type EngineStatus =
  | { state: 'loading' }
  | { state: 'ok'; message: string }
  | { state: 'error'; message: string }

export function StatusBadge({ status }: { status: EngineStatus }) {
  const base = 'inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs'
  if (status.state === 'loading')
    return (
      <span className={`${base} border-zinc-700 text-zinc-400`}>
        <Loader className="size-3.5 animate-spin" /> engine: connecting…
      </span>
    )
  if (status.state === 'error')
    return (
      <span className={`${base} border-red-900 bg-red-950/40 text-red-400`}>
        <CircleAlert className="size-3.5" /> {status.message}
      </span>
    )
  return (
    <span className={`${base} border-emerald-900 bg-emerald-950/40 text-emerald-400`}>
      <CircleCheck className="size-3.5" /> {status.message}
    </span>
  )
}