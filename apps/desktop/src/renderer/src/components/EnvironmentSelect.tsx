import { Layers } from 'lucide-react'

interface Props {
  names: string[]
  active: string | null
  onSelect: (name: string | null) => void
  onManage: () => void
}

export function EnvironmentSelect({ names, active, onSelect, onManage }: Props) {
  const value = active && names.includes(active) ? active : ''
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label="Active environment"
        value={value}
        onChange={(e) => onSelect(e.target.value || null)}
        className="max-w-40 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
      >
        <option value="">No environment</option>
        {names.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <button type="button" aria-label="Manage environments" title="Manage environments" onClick={onManage} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
        <Layers className="size-4" />
      </button>
    </div>
  )
}
