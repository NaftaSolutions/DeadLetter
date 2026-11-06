import { X } from 'lucide-react'
import { newRow, type KeyValue } from '../request'

interface Props {
  rows: KeyValue[]
  onChange: (rows: KeyValue[]) => void
  /** What a row is called in labels, e.g. `header` or `field`. */
  noun?: string
  /** Rows can be switched off (headers) or only deleted (form fields). */
  toggleable?: boolean
}

const input =
  'w-full bg-transparent px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-offset-[-2px]'

export function KeyValueEditor({ rows, onChange, noun = 'header', toggleable = true }: Props) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  const update = (id: string, patch: Partial<KeyValue>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
    // Always keep one blank row at the end so typing never requires an "add" button.
    const last = next[next.length - 1]
    onChange(last && (last.name || last.value) ? [...next, newRow()] : next)
  }
  const remove = (id: string) => {
    const next = rows.filter((r) => r.id !== id)
    onChange(next.length ? next : [newRow()])
  }

  return (
    <div role="table" aria-label={`${Noun}s`} className="text-xs">
      <div
        role="row"
        className="grid grid-cols-[2rem_1fr_1fr_2rem] border-b border-zinc-800 text-[11px] uppercase tracking-wide text-zinc-500"
      >
        <span role="columnheader" className="sr-only">
          Enabled
        </span>
        <span role="columnheader" className="col-start-2 px-2 py-1.5">
          Name
        </span>
        <span role="columnheader" className="px-2 py-1.5">
          Value
        </span>
      </div>
      {rows.map((r, i) => {
        const blank = !r.name && !r.value
        return (
          <div
            role="row"
            key={r.id}
            className="group grid grid-cols-[2rem_1fr_1fr_2rem] items-center border-b border-zinc-900"
          >
            <input
              type="checkbox"
              checked={r.enabled}
              disabled={blank}
              onChange={(e) => update(r.id, { enabled: e.target.checked })}
              aria-label={`Enable ${noun} ${i + 1}`}
              className={`mx-auto size-3.5 accent-zinc-300 disabled:opacity-20 ${toggleable ? '' : 'invisible'}`}
            />
            <input
              value={r.name}
              onChange={(e) => update(r.id, { name: e.target.value })}
              placeholder={Noun}
              aria-label={`${Noun} ${i + 1} name`}
              spellCheck={false}
              className={`${input} ${r.enabled ? '' : 'opacity-40'}`}
            />
            <input
              value={r.value}
              onChange={(e) => update(r.id, { value: e.target.value })}
              placeholder="Value"
              aria-label={`${Noun} ${i + 1} value`}
              spellCheck={false}
              className={`${input} ${r.enabled ? '' : 'opacity-40'}`}
            />
            <button
              type="button"
              onClick={() => remove(r.id)}
              aria-label={`Remove ${noun} ${i + 1}`}
              className={`mx-auto rounded p-1 text-zinc-600 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100 ${blank ? 'invisible' : 'opacity-0'}`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
