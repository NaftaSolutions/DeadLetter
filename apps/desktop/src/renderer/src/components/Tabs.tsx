import type { KeyboardEvent, ReactNode } from 'react'

export interface TabDef<T extends string> {
  id: T
  label: string
  /** Small indicator, e.g. number of active headers. */
  count?: number
}

interface TabsProps<T extends string> {
  label: string
  tabs: TabDef<T>[]
  value: T
  onChange: (id: T) => void
  trailing?: ReactNode
}

export function Tabs<T extends string>({ label, tabs, value, onChange, trailing }: TabsProps<T>) {
  const onKeyDown = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === value)
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = tabs[(i + step + tabs.length) % tabs.length]
    onChange(next.id)
    document.getElementById(`tab-${label}-${next.id}`)?.focus()
  }

  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-3">
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-4">
        {tabs.map((t) => {
          const selected = t.id === value
          return (
            <button
              key={t.id}
              id={`tab-${label}-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`panel-${label}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={`-mb-px border-b-2 py-2 text-xs font-medium transition-colors ${
                selected
                  ? 'border-zinc-200 text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
              {t.count ? <span className="ml-1.5 text-zinc-500">{t.count}</span> : null}
            </button>
          )
        })}
      </div>
      {trailing}
    </div>
  )
}
