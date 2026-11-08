import { Plus, X } from 'lucide-react'

interface Props {
  assertions: string[]
  onChange: (assertions: string[]) => void
}

const EXAMPLES = ['status == 200', 'time < 500', 'header content-type contains json', 'json $.data.id exists']

export function AssertionsEditor({ assertions, onChange }: Props) {
  const set = (i: number, value: string) => onChange(assertions.map((a, j) => (j === i ? value : a)))
  return (
    <div className="p-3">
      <ul className="space-y-1.5">
        {assertions.map((a, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              value={a}
              onChange={(e) => set(i, e.target.value)}
              placeholder={EXAMPLES[i % EXAMPLES.length]}
              aria-label={`Assertion ${i + 1}`}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-zinc-800 bg-transparent px-2 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
            />
            <button
              type="button"
              onClick={() => onChange(assertions.filter((_, j) => j !== i))}
              aria-label={`Remove assertion ${i + 1}`}
              className="rounded p-1 text-zinc-500 hover:text-zinc-200"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...assertions, ''])}
        className="mt-2 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <Plus className="size-3.5" /> Add assertion
      </button>
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        Checked against each response. Subjects: <code>status</code> <code>time</code> <code>size</code> <code>body</code>{' '}
        <code>header &lt;name&gt;</code> <code>json $.path</code>. Operators: <code>==</code> <code>!=</code> <code>&lt;</code>{' '}
        <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code> <code>contains</code> <code>exists</code> (and <code>!</code> forms).
        Values may use <code>{'{{variables}}'}</code>.
      </p>
    </div>
  )
}
