import { useState } from 'react'

interface Props {
  initial?: string
  placeholder: string
  label: string
  onCommit: (value: string) => void
  onCancel: () => void
}

/** Single-line name editor: Enter confirms, Escape or leaving the field cancels. */
export function InlineInput({ initial = '', placeholder, label, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial)
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
        if (e.key === 'Enter') {
          const name = value.trim()
          if (name) onCommit(name)
          else onCancel()
        }
      }}
      className="h-6 min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-900 px-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
    />
  )
}
