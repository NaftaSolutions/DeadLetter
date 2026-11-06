import { lazy, memo, Suspense, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { ResponsePayload } from '@shared/api'
import { parseSetCookies } from '../cookies'
import type { SendState } from '../useSend'
import { useResponseBody } from '../useResponseBody'
import { BodyToolbar } from './BodyToolbar'
import { Tabs } from './Tabs'

const CodeViewer = lazy(() => import('./CodeViewer').then((m) => ({ default: m.CodeViewer })))

type Tab = 'body' | 'cookies' | 'headers'

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

function Empty({ children }: { children: string }) {
  return <div className="flex flex-1 items-center justify-center text-zinc-600">{children}</div>
}

function Loaded({ res }: { res: ResponsePayload }) {
  const [tab, setTab] = useState<Tab>('body')
  const [raw, setRaw] = useState(false)
  const [wrap, setWrap] = useState(true)
  const { text, language, canPrettify, large, needsFormat, format } = useResponseBody(res, raw)
  const cookies = parseSetCookies(res.headers)

  return (
    <>
      <Tabs
        label="response"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'body', label: 'Body' },
          { id: 'cookies', label: 'Cookies', count: cookies.length },
          { id: 'headers', label: 'Headers', count: res.headers.length }
        ]}
        trailing={
          <div className="flex items-center gap-3 py-1.5 font-mono text-xs text-zinc-400" aria-label="Response summary">
            <span className={`rounded border px-1.5 py-0.5 font-semibold ${statusTone(res.status)}`}>
              {res.status} {res.statusText}
            </span>
            <span title="Time until the full body was received">{formatTime(res.latencyMs)}</span>
            <span>{formatSize(res.sizeBytes)}</span>
          </div>
        }
      />
      {tab === 'body' && res.body && (
        <BodyToolbar
          canPrettify={canPrettify}
          needsFormat={needsFormat}
          onFormat={format}
          raw={raw}
          wrap={wrap}
          text={text}
          onRaw={setRaw}
          onWrap={setWrap}
        />
      )}
      <div
        id="panel-response"
        role="tabpanel"
        aria-labelledby={`tab-response-${tab}`}
        className={`min-h-0 flex-1 ${tab === 'body' && res.body ? 'overflow-hidden' : 'overflow-auto'}`}
      >
        {tab === 'body' &&
          (res.body ? (
            <Suspense fallback={<div className="p-3 text-zinc-600">Loading viewer…</div>}>
              <CodeViewer value={text} language={language} wrap={wrap} large={large} />
            </Suspense>
          ) : (
            <div className="p-3 text-zinc-600">Empty response body</div>
          ))}

        {tab === 'cookies' &&
          (cookies.length === 0 ? (
            <div className="p-3 text-zinc-600">This response did not set any cookies</div>
          ) : (
            <table className="w-full border-collapse text-left font-mono text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-1.5 font-medium">Name</th>
                  <th className="px-3 py-1.5 font-medium">Value</th>
                  <th className="px-3 py-1.5 font-medium">Attributes</th>
                </tr>
              </thead>
              <tbody>
                {cookies.map((c, i) => (
                  <tr key={i} className="border-b border-zinc-900 align-top">
                    <td className="px-3 py-1.5 text-zinc-300">{c.name}</td>
                    <td className="break-all px-3 py-1.5 text-zinc-300">{c.value}</td>
                    <td className="px-3 py-1.5 text-zinc-500">{c.attributes.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

        {tab === 'headers' && (
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

export const ResponsePane = memo(function ResponsePane({ state }: { state: SendState }) {
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
})
