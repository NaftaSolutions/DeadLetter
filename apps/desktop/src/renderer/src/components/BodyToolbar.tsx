import { useState } from 'react'
import { Check, Copy, WrapText } from 'lucide-react'

interface Props {
  canPrettify: boolean
  /** Large JSON is shown unformatted until the user asks. */
  needsFormat: boolean
  onFormat: () => void
  raw: boolean
  wrap: boolean
  /** What the viewer currently shows; this is what Copy puts on the clipboard. */
  text: string
  onRaw: (raw: boolean) => void
  onWrap: (wrap: boolean) => void
}

const btn = 'flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'

export function BodyToolbar({ canPrettify, needsFormat, onFormat, raw, wrap, text, onRaw, onWrap }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard can be unavailable; nothing useful to tell the user */
    }
  }

  return (
    <div className="flex items-center gap-1 border-b border-zinc-900 px-2 py-1">
      {canPrettify && (
        <div role="group" aria-label="Body format" className="mr-1 flex rounded border border-zinc-800 text-xs">
          {(['Pretty', 'Raw'] as const).map((label) => {
            const active = (label === 'Raw') === raw
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() => onRaw(label === 'Raw')}
                className={`px-2 py-0.5 first:rounded-l last:rounded-r ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
      {needsFormat && (
        <button type="button" onClick={onFormat} className={btn} title="Large response: shown as received. Pretty-printing it uses more memory.">
          Format
        </button>
      )}
      <button type="button" aria-pressed={wrap} onClick={() => onWrap(!wrap)} className={`${btn} ${wrap ? 'text-zinc-100' : ''}`}>
        <WrapText className="size-3.5" /> Wrap
      </button>
      <button type="button" onClick={() => void copy()} className={btn}>
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="ml-auto text-[11px] text-zinc-600">Ctrl+F to search</span>
    </div>
  )
}
