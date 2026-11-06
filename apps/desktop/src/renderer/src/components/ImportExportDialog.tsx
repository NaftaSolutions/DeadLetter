import { useEffect, useRef, useState } from 'react'
import { CircleCheck, Download, FileUp, Terminal, TriangleAlert, X } from 'lucide-react'
import type { ImportOutcome } from '@shared/api'
import { cleanError } from '../errors'

interface Props {
  /** Called after anything was written to the workspace, so the sidebar and environments refresh. */
  onChanged: () => Promise<void> | void
  /** Called with the path of a request created from a cURL command, which the app opens. */
  onCurlImported: (path: string) => Promise<void> | void
  onClose: () => void
}

const SOURCES: Record<string, string> = {
  postman: 'Postman',
  insomnia: 'Insomnia',
  openapi: 'OpenAPI',
  hoppscotch: 'Hoppscotch',
  har: 'a HAR file',
  http: 'an .http file',
  bruno: 'Bruno'
}

const section = 'space-y-2 rounded-md border border-zinc-800 p-3'
const primary = 'rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40'
const secondary = 'flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-40'

export function ImportExportDialog({ onChanged, onCurlImported, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const [curl, setCurl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setOutcome(null)
    setExported(null)
    try {
      await fn()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  const importFile = () =>
    run(async () => {
      const result = await window.deadletter.interop.importFile()
      if (!result) return
      setOutcome(result)
      await onChanged()
    })

  const importFolder = () =>
    run(async () => {
      const result = await window.deadletter.interop.importFolder()
      if (!result) return
      setOutcome(result)
      await onChanged()
    })

  const importCurl = () =>
    run(async () => {
      const path = await window.deadletter.interop.importCurl(curl)
      await onChanged()
      await onCurlImported(path)
      ref.current?.close()
    })

  const exportPostman = () =>
    run(async () => {
      setExported(await window.deadletter.interop.exportPostman())
    })

  return (
    <dialog
      ref={ref}
      aria-labelledby="interop-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      className="m-auto w-[34rem] max-w-[92vw] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-200 backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 id="interop-title" className="text-sm font-semibold">Import &amp; export</h2>
        <button type="button" aria-label="Close import and export" onClick={() => ref.current?.close()} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <X className="size-4" />
        </button>
      </div>

      <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4 text-xs">
        {error && <p role="alert" className="break-words text-red-400">{error}</p>}

        {exported && (
          <p role="status" className="flex items-start gap-1.5 text-emerald-400">
            <CircleCheck className="mt-0.5 size-3.5 shrink-0" /> <span className="break-all">Saved to {exported}</span>
          </p>
        )}

        {outcome && (
          <div role="status" className="space-y-1.5 rounded-md border border-emerald-900 bg-emerald-950/30 p-3">
            <p className="flex items-start gap-1.5 text-emerald-300">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {outcome.written > 0 ? (
                  <>
                    Imported {outcome.written} request{outcome.written === 1 ? '' : 's'} from {SOURCES[outcome.source] ?? outcome.source} into{' '}
                    <code className="text-emerald-200">{outcome.folder}</code>
                  </>
                ) : (
                  <>Imported from {SOURCES[outcome.source] ?? outcome.source}</>
                )}
                {outcome.environments.length > 0 && (
                  <>
                    {outcome.written > 0 ? ' and created the' : ': created the'} environment{outcome.environments.length === 1 ? '' : 's'}{' '}
                    {outcome.environments.map((n, i) => (
                      <span key={n}>
                        {i > 0 && ', '}
                        <code className="text-emerald-200">{n}</code>
                      </span>
                    ))}
                  </>
                )}
                .
              </span>
            </p>
            {outcome.warnings.map((w, i) => (
              <p key={i} className="flex items-start gap-1.5 text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> <span className="break-words">{w}</span>
              </p>
            ))}
          </div>
        )}

        <section className={section} aria-label="Import from a file">
          <h3 className="flex items-center gap-1.5 font-medium text-zinc-300"><FileUp className="size-3.5" /> From a file</h3>
          <p className="text-zinc-500">
            Postman (collections and environments), Insomnia (v4 and v5), OpenAPI / Swagger (JSON or YAML), Hoppscotch,
            HAR exports from browser dev tools, .http files from VS Code or JetBrains, and Bruno collection folders. Requests are written to a new
            folder, and variables become new environments. Nothing is overwritten.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void importFile()} className={secondary}>Choose file…</button>
            <button type="button" disabled={busy} onClick={() => void importFolder()} className={secondary} title="A folder of .bru files with a bruno.json">
              Bruno folder…
            </button>
          </div>
        </section>

        <section className={section} aria-label="Import from cURL">
          <h3 className="flex items-center gap-1.5 font-medium text-zinc-300"><Terminal className="size-3.5" /> From a cURL command</h3>
          <textarea
            value={curl}
            onChange={(e) => setCurl(e.target.value)}
            placeholder={"curl -X POST 'https://api.example.com/users' -H 'Content-Type: application/json' -d '{\"name\":\"ada\"}'"}
            aria-label="cURL command"
            spellCheck={false}
            rows={4}
            className="block w-full resize-y rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-xs placeholder:text-zinc-600"
          />
          <button type="button" disabled={busy || !curl.trim()} onClick={() => void importCurl()} className={primary}>Import request</button>
        </section>

        <section className={section} aria-label="Export">
          <h3 className="flex items-center gap-1.5 font-medium text-zinc-300"><Download className="size-3.5" /> Export</h3>
          <p className="text-zinc-500">
            The whole workspace as one Postman v2.1 collection. Use <em>Copy cURL</em> above a request to export a single one.
            Your files are already plain <code>.http</code> / <code>.json</code>, so git is the other way to share them.
          </p>
          <button type="button" disabled={busy} onClick={() => void exportPostman()} className={secondary}>Export as Postman…</button>
        </section>

      </div>
    </dialog>
  )
}
