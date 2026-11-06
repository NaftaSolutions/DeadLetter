import { Check, Save, Terminal } from 'lucide-react'
import { useState } from 'react'

interface Props {
  name: string
  path: string | null
  dirty: boolean
  onSave: () => void
  /** Copies the request as a cURL command; resolves once it is on the clipboard. */
  onCopyCurl: () => Promise<void>
  canCopyCurl: boolean
}

export function RequestTitle({ name, path, dirty, onSave, onCopyCurl, canCopyCurl }: Props) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await onCopyCurl()
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-xs font-medium text-zinc-200">{path ? name : 'Scratch request'}</span>
        {dirty && <span className="text-[11px] text-amber-400">● unsaved</span>}
        {!path && <span className="truncate text-[11px] text-zinc-600">not saved to disk — pick or create a request in the sidebar</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        disabled={!canCopyCurl}
        title="Copy this request as a cURL command"
        className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs hover:bg-zinc-800 disabled:cursor-default disabled:border-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent"
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Terminal className="size-3.5" />}
        {copied ? 'Copied' : 'Copy cURL'}
      </button>
      {path && (
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs hover:bg-zinc-800 disabled:cursor-default disabled:border-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent"
        >
          <Save className="size-3.5" />
          Save
          <kbd className="font-mono text-[10px] opacity-60">{navigator.platform.includes('Mac') ? '⌘S' : 'Ctrl S'}</kbd>
        </button>
      )}
      </div>
    </div>
  )
}
