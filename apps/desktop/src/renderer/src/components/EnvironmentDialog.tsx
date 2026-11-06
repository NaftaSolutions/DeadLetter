import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Lock, Plus, Trash2, X } from 'lucide-react'
import type { Environment } from '@shared/api'
import { cleanError } from '../errors'

interface Row {
  id: string
  enabled: boolean
  name: string
  value: string
  secret: boolean
}

interface Props {
  names: string[]
  initial: string | null
  onChanged: () => Promise<void> | void
  /** Called after a delete so the app can drop the active selection. */
  onDeleted: (name: string) => void
  onClose: () => void
}

const newRow = (): Row => ({ id: crypto.randomUUID(), enabled: true, name: '', value: '', secret: false })
const toRows = (e: Environment): Row[] => [...e.variables.map((v) => ({ id: crypto.randomUUID(), ...v })), newRow()]
const input = 'w-full bg-transparent px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-offset-[-2px]'

export function EnvironmentDialog({ names, initial, onChanged, onDeleted, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [current, setCurrent] = useState<string | null>(initial ?? names[0] ?? null)
  const [rows, setRows] = useState<Row[]>([newRow()])
  const [dirty, setDirty] = useState(false)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  useEffect(() => {
    setDirty(false)
    setRevealed(new Set())
    if (!current) {
      setRows([newRow()])
      return
    }
    let stale = false
    window.deadletter.environments.read(current).then(
      (env) => {
        if (!stale) setRows(toRows(env))
      },
      (e: unknown) => {
        if (!stale) setError(cleanError(e))
      }
    )
    return () => {
      stale = true
    }
  }, [current])

  const confirmLeave = (): boolean => !dirty || window.confirm('Discard unsaved changes to this environment?')

  const edit = (id: string, patch: Partial<Row>) => {
    setDirty(true)
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
    const last = next[next.length - 1]
    setRows(last && (last.name || last.value) ? [...next, newRow()] : next)
  }
  const remove = (id: string) => {
    setDirty(true)
    const next = rows.filter((r) => r.id !== id)
    setRows(next.length ? next : [newRow()])
  }
  const toggleReveal = (id: string) =>
    setRevealed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const run = async (fn: () => Promise<void>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const save = () =>
    run(async () => {
      if (!current) return
      const variables = rows
        .filter((r) => r.name.trim())
        .map(({ name, value, enabled, secret }) => ({ name: name.trim(), value, enabled, secret }))
      await window.deadletter.environments.write({ name: current, variables })
      setDirty(false)
      await onChanged()
    })

  const create = (name: string) =>
    run(async () => {
      const trimmed = name.trim()
      setAdding(false)
      if (!trimmed) return
      if (names.some((n) => n.toLowerCase() === trimmed.toLowerCase())) throw new Error(`"${trimmed}" already exists`)
      await window.deadletter.environments.write({ name: trimmed, variables: [] })
      await onChanged()
      setCurrent(trimmed)
    })

  const del = () =>
    run(async () => {
      if (!current || !window.confirm(`Delete environment "${current}"? This removes its files.`)) return
      await window.deadletter.environments.delete(current)
      onDeleted(current)
      await onChanged()
      setCurrent(names.find((n) => n !== current) ?? null)
    })

  return (
    <dialog
      ref={ref}
      aria-labelledby="env-title"
      onClose={onClose}
      onCancel={(e) => {
        if (!confirmLeave()) e.preventDefault()
      }}
      className="m-auto w-[40rem] max-w-[92vw] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-200 backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 id="env-title" className="text-sm font-semibold">Environments</h2>
        <button type="button" aria-label="Close environments" onClick={() => confirmLeave() && ref.current?.close()} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          {adding ? (
            <input
              autoFocus
              aria-label="New environment name"
              placeholder="Environment name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create(e.currentTarget.value)
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setAdding(false)
                }
              }}
              onBlur={(e) => void create(e.currentTarget.value)}
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs"
            />
          ) : (
            <select
              aria-label="Environment to edit"
              value={current ?? ''}
              disabled={names.length === 0}
              onChange={(e) => confirmLeave() && setCurrent(e.target.value)}
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs"
            >
              {names.length === 0 && <option value="">No environments yet</option>}
              {names.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => confirmLeave() && setAdding(true)} className="flex items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs hover:bg-zinc-800">
            <Plus className="size-3.5" /> New
          </button>
          <button type="button" aria-label="Delete environment" title="Delete environment" disabled={!current} onClick={() => void del()} className="rounded-md border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-30">
            <Trash2 className="size-3.5" />
          </button>
        </div>

        {current ? (
          <div role="table" aria-label="Variables" className="max-h-72 overflow-y-auto rounded border border-zinc-800 text-xs">
            {rows.map((r, i) => {
              const blank = !r.name && !r.value
              const shown = !r.secret || revealed.has(r.id)
              return (
                <div role="row" key={r.id} className="group grid grid-cols-[2rem_1fr_1.5fr_4.5rem] items-center border-b border-zinc-900 last:border-b-0">
                  <input type="checkbox" checked={r.enabled} disabled={blank} onChange={(e) => edit(r.id, { enabled: e.target.checked })} aria-label={`Enable variable ${i + 1}`} className="mx-auto size-3.5 accent-zinc-300 disabled:opacity-20" />
                  <input value={r.name} onChange={(e) => edit(r.id, { name: e.target.value })} placeholder="variable" aria-label={`Variable ${i + 1} name`} spellCheck={false} className={`${input} ${r.enabled ? '' : 'opacity-40'}`} />
                  <input
                    value={r.value}
                    type={shown ? 'text' : 'password'}
                    onChange={(e) => edit(r.id, { value: e.target.value })}
                    placeholder="value"
                    aria-label={`Variable ${i + 1} value`}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${input} ${r.enabled ? '' : 'opacity-40'}`}
                  />
                  <span className={`flex items-center justify-end gap-0.5 pr-1 ${blank ? 'invisible' : ''}`}>
                    {r.secret && (
                      <button type="button" aria-label={shown ? 'Hide value' : 'Show value'} onClick={() => toggleReveal(r.id)} className="rounded p-1 text-zinc-500 hover:text-zinc-200">
                        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    )}
                    <button type="button" aria-label={`Variable ${i + 1} secret`} aria-pressed={r.secret} title="Secret: kept out of git" onClick={() => edit(r.id, { secret: !r.secret })} className={`rounded p-1 ${r.secret ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-200'}`}>
                      <Lock className="size-3.5" />
                    </button>
                    <button type="button" aria-label={`Remove variable ${i + 1}`} onClick={() => remove(r.id)} className="rounded p-1 text-zinc-600 opacity-0 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100">
                      <X className="size-3.5" />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="rounded border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
            Create an environment, then use <code className="text-zinc-300">{'{{variable}}'}</code> in URLs, headers and bodies.
          </p>
        )}

        <p className="text-xs text-zinc-500">
          Stored in <code>.deadletter/environments/</code>. Variables marked <Lock className="inline size-3 text-amber-400" /> keep their values in a git-ignored <code>.secrets.json</code> file.
        </p>
        {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
        <button type="button" onClick={() => confirmLeave() && ref.current?.close()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">Close</button>
        <button type="button" disabled={!current || !dirty} onClick={() => void save()} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40">Save</button>
      </div>
    </dialog>
  )
}
