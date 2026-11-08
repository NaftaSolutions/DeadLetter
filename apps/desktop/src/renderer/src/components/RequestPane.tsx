import { useState } from 'react'
import { detectAuth } from '../auth'
import type { RequestDraft } from '../request'
import { AuthEditor } from './AuthEditor'
import { BodyEditor } from './BodyEditor'
import { KeyValueEditor } from './KeyValueEditor'
import { Tabs } from './Tabs'

type Tab = 'headers' | 'auth' | 'body'

interface Props {
  draft: RequestDraft
  /** A WebSocket handshake has no body, so the Body tab is hidden. */
  noBody?: boolean
  onChange: (patch: Partial<RequestDraft>) => void
}

export function RequestPane({ draft, noBody, onChange }: Props) {
  const [picked, setTab] = useState<Tab>('headers')
  const tab: Tab = noBody && picked === 'body' ? 'headers' : picked
  const activeHeaders = draft.headers.filter((h) => h.enabled && h.name.trim()).length
  const hasAuth = detectAuth(draft.headers).kind !== 'none'

  return (
    <section aria-label="Request" className="flex min-h-0 flex-1 flex-col">
      <Tabs
        label="request"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'headers', label: 'Headers', count: activeHeaders },
          { id: 'auth', label: 'Auth', count: hasAuth ? 1 : 0 },
          ...(noBody ? [] : [{ id: 'body' as const, label: 'Body', count: draft.body.trim() ? 1 : 0 }])
        ]}
      />
      <div
        id="panel-request"
        role="tabpanel"
        aria-labelledby={`tab-request-${tab}`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {tab === 'headers' && <KeyValueEditor rows={draft.headers} onChange={(headers) => onChange({ headers })} />}
        {tab === 'auth' && <AuthEditor headers={draft.headers} onHeaders={(headers) => onChange({ headers })} />}
        {tab === 'body' && <BodyEditor headers={draft.headers} body={draft.body} onChange={onChange} />}
      </div>
    </section>
  )
}
