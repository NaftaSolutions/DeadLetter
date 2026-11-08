import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { TreeNode } from '@shared/api'
import { cleanError } from '../errors'
import { fromFile, toPayload } from '../request'
import { entryPassed, isStreamUrl, summarize, type RunEntry } from '../runner'

interface Props {
  /** Folder being run ('' = whole workspace) and its display name. */
  dir: string
  title: string
  requests: TreeNode[]
  onClose: () => void
}

async function runOne(node: TreeNode): Promise<RunEntry> {
  const entry: RunEntry = { path: node.path, name: node.name, method: node.method ?? '', tests: [] }
  try {
    const draft = fromFile(await window.deadletter.collection.read(node.path))
    if (isStreamUrl(draft.url)) return { ...entry, skipped: true, error: 'Streaming request, not run' }
    if (!draft.url.trim()) return { ...entry, error: 'No URL' }
    const response = await window.deadletter.executeRequest(toPayload(draft))
    const checks = draft.assertions.filter((a) => a.trim())
    const tests = checks.length ? await window.deadletter.runAssertions(checks, response) : []
    return { ...entry, status: response.status, timeMs: response.latencyMs, tests }
  } catch (e) {
    return { ...entry, error: cleanError(e) }
  }
}

export function RunnerDialog({ dir, title, requests, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [entries, setEntries] = useState<RunEntry[]>([])
  const [running, setRunning] = useState(true)
  const stop = useRef(false)

  useEffect(() => {
    ref.current?.showModal()
    let cancelled = false
    stop.current = false
    void (async () => {
      for (const node of requests) {
        if (cancelled || stop.current) break
        const entry = await runOne(node)
        if (cancelled) return
        setEntries((prev) => [...prev, entry])
      }
      if (!cancelled) setRunning(false)
    })()
    return () => {
      cancelled = true
    }
    // A run is fixed when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sum = summarize(entries)
  return (
    <dialog
      ref={ref}
      aria-labelledby="runner-title"
      onClose={onClose}
      className="m-auto flex max-h-[80vh] w-[44rem] max-w-[92vw] flex-col rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-200 backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 id="runner-title" className="text-sm font-semibold">
          Run {dir === '' ? 'all requests' : title}
        </h2>
        <button type="button" aria-label="Close runner" onClick={() => ref.current?.close()} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <X className="size-4" />
        </button>
      </div>

      <p role="status" className="border-b border-zinc-900 px-4 py-2 font-mono text-xs text-zinc-400">
        {requests.length === 0
          ? 'No requests to run'
          : `${running ? 'Running' : 'Finished'}: ${sum.passed} passed, ${sum.failed} failed${sum.skipped ? `, ${sum.skipped} skipped` : ''} of ${requests.length}`}
      </p>

      <ul aria-label="Run results" className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs">
        {entries.map((e) => {
          const ok = entryPassed(e)
          return (
            <li key={e.path} className="border-b border-zinc-900 px-4 py-1.5">
              <div className="flex items-center gap-2">
                <span className={e.skipped ? 'text-zinc-500' : ok ? 'text-emerald-400' : 'text-red-400'} aria-label={e.skipped ? 'Skipped' : ok ? 'Passed' : 'Failed'}>
                  {e.skipped ? '–' : ok ? '✓' : '✗'}
                </span>
                <span className="w-12 shrink-0 text-zinc-500">{e.method}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-200" title={e.path}>{e.name}</span>
                {e.status !== undefined && <span className="text-zinc-400">{e.status}</span>}
                {e.timeMs !== undefined && <span className="w-16 text-right text-zinc-500">{Math.round(e.timeMs)} ms</span>}
              </div>
              {e.error && <p className="pl-6 text-red-300">{e.error}</p>}
              {e.tests.filter((t) => !t.passed).map((t, i) => (
                <p key={i} className="pl-6 text-red-300">✗ {t.assertion} — {t.message}</p>
              ))}
            </li>
          )
        })}
      </ul>

      <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-2.5">
        {running ? (
          <button type="button" onClick={() => { stop.current = true; setRunning(false) }} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
            Stop
          </button>
        ) : (
          <button type="button" onClick={() => ref.current?.close()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
            Close
          </button>
        )}
      </div>
    </dialog>
  )
}
