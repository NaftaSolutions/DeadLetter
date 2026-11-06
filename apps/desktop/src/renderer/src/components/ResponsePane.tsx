import { useMemo, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { ResponsePayload } from '@shared/api'
import type { SendState } from '../useSend'
import { Tabs } from './Tabs'

type Tab = 'body' | 'headers'

const PRETTY_LIMIT = 1_000_000

function statusTone(status: number): string {
  if (status >= 500) return 'border-red-900 bg-red-950/50 text-red-300'
  if (status >= 400) return 'border-amber-900 bg-amber-950/50 text-amber-300'
  if (status >= 300) return 'border-sky-900 bg-sky-950/50 text-sky-300'
  return 'border-emerald-900 bg-emerald-950/50 text-emerald-300'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const formatTime = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`)

function prettyBody(res: ResponsePayload): string {
  if (res.sizeBytes > PRETTY_LIMIT) return res.body
  const looksJson = /json/i.test(res.headers.find((h) => h.name === 'content-type')?.value ?? '')
  if (!looksJson) return res.body
  try {
    return JSON.stringify(JSON.parse(res.body), null, 2)
  } catch {
    return res.body
  }
}

function Empty({ children }: { children: string }) {
  return <div className="flex flex-1 items-center justify-center text-zinc-600">{children}</div>
}

function Loaded({ res }: { res: ResponsePayload }) {
  const [tab, setTab] = useState<Tab>('body')
  const body = useMemo(() => prettyBody(res), [res])

  return (
    <>
      <Tabs
        label="response"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'body', label: 'Body' },
          { id: 'headers', label: 'Headers', count: res.headers.length }
        ]}
        trailing={
          <div className="flex items-center gap-3 py-1.5 font-mono text-xs text-zinc-400" aria-label="Response summary">
            <span className={`rounded border px-1.5 py-0.5 font-semibold ${statusTone(res.status)}`}>
              {res.status} {res.statusText}
            </span>
            <span>{formatTime(res.latencyMs)}</span>
            <span>{formatSize(res.sizeBytes)}</span>
          </div>
        }
      />
      <div
        id="panel-response"
        role="tabpanel"
        aria-labelledby={`tab-response-${tab}`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {tab === 'body' ? (
          res.body ? (
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-zinc-300">
              {body}
            </pre>
          ) : (
            <div className="p-3 text-zinc-600">Empty response body</div>
          )
        ) : (
          <dl className="grid grid-cols-[minmax(8rem,max-content)_1fr] gap-x-4 gap-y-1 p-3 font-mono text-xs">
            {res.headers.map((h, i) => (
              <div key={i} className="contents">
                <dt className="text-zinc-500">{h.name}</dt>
                <dd className="break-all text-zinc-300">{h.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </>
  )
}

export function ResponsePane({ state }: { state: SendState }) {
  return (
    <section
      aria-label="Response"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col border-t border-zinc-800"
    >
      {state.kind === 'idle' && <Empty>Enter a URL and press Send</Empty>}
      {state.kind === 'loading' && <Empty>Sending…</Empty>}
      {state.kind === 'error' && (
        <div
          role="alert"
          className="m-3 flex items-start gap-2 rounded-md border border-red-900 bg-red-950/40 p-3 text-red-300"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <p className="break-words font-mono text-xs leading-relaxed">{state.message}</p>
        </div>
      )}
      {state.kind === 'done' && <Loaded res={state.response} />}
    </section>
  )
}
