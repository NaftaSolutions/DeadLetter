import { useState } from 'react'
import type { RequestDraft } from '../request'
import { KeyValueEditor } from './KeyValueEditor'
import { Tabs } from './Tabs'

type Tab = 'headers' | 'body'

interface Props {
  draft: RequestDraft
  onChange: (patch: Partial<RequestDraft>) => void
}

export function RequestPane({ draft, onChange }: Props) {
  const [tab, setTab] = useState<Tab>('headers')
  const activeHeaders = draft.headers.filter((h) => h.enabled && h.name.trim()).length

  return (
    <section aria-label="Request" className="flex min-h-0 flex-1 flex-col">
      <Tabs
        label="request"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'headers', label: 'Headers', count: activeHeaders },
          { id: 'body', label: 'Body', count: draft.body.trim() ? 1 : 0 }
        ]}
      />
      <div
        id="panel-request"
        role="tabpanel"
        aria-labelledby={`tab-request-${tab}`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {tab === 'headers' ? (
          <KeyValueEditor rows={draft.headers} onChange={(headers) => onChange({ headers })} />
        ) : (
          <textarea
            value={draft.body}
            onChange={(e) => onChange({ body: e.target.value })}
            placeholder='{"hello": "world"}'
            aria-label="Request body"
            spellCheck={false}
            className="block size-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-offset-[-2px]"
          />
        )}
      </div>
    </section>
  )
}
