import { ChevronDown, Loader, Plug, Send, Square } from 'lucide-react'
import type { StreamKind } from '@shared/api'
import { METHODS, type Method } from '../request'

interface Props {
  method: Method
  url: string
  loading: boolean
  /** Set for WebSocket / SSE requests: Send becomes Connect, and Stop while connected. */
  stream?: StreamKind | null
  connected?: boolean
  onMethod: (m: Method) => void
  onUrl: (u: string) => void
  onSend: () => void
  onStop?: () => void
}

export function RequestBar({ method, url, loading, stream, connected, onMethod, onUrl, onSend, onStop }: Props) {
  const Icon = connected ? Square : loading ? Loader : stream ? Plug : Send
  return (
    <form
      className="flex gap-2 border-b border-zinc-800 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (connected) onStop?.()
        else onSend()
      }}
    >
      <div className="relative">
        <select
          value={method}
          onChange={(e) => onMethod(e.target.value as Method)}
          aria-label="HTTP method"
          disabled={stream === 'ws'}
          className="h-9 appearance-none rounded-md border border-zinc-800 bg-zinc-900 pl-3 pr-8 font-mono text-xs font-semibold text-zinc-100 hover:border-zinc-700 disabled:opacity-50"
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500"
        />
      </div>

      <input
        value={url}
        onChange={(e) => onUrl(e.target.value)}
        placeholder="https://api.example.com/users"
        aria-label="Request URL"
        spellCheck={false}
        autoFocus
        className="h-9 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 hover:border-zinc-700"
      />

      <button
        type="submit"
        disabled={!url.trim() || (loading && !connected)}
        className="flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-4 text-sm font-semibold text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
      >
        <Icon className={`size-3.5 ${loading && !connected ? 'animate-spin' : ''}`} />
        {connected ? 'Stop' : stream ? 'Connect' : 'Send'}
        <kbd className="hidden rounded border border-current/20 px-1 font-mono text-[10px] font-normal opacity-60 sm:inline">
          {navigator.platform.includes('Mac') ? '⌘↵' : 'Ctrl ↵'}
        </kbd>
      </button>
    </form>
  )
}
