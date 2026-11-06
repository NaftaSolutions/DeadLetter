import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { RequestFormat, Settings } from '@shared/api'

interface Props {
  settings: Settings
  onFormat: (f: RequestFormat) => void
  onChooseWorkspace: () => void
  onClose: () => void
}

const FORMATS: { id: RequestFormat; label: string; hint: string }[] = [
  { id: 'http', label: '.http', hint: 'Readable text, works with VS Code REST Client and JetBrains' },
  { id: 'json', label: '.json', hint: 'Structured, easy to process with scripts' }
]

export function SettingsDialog({ settings, onFormat, onChooseWorkspace, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog
      ref={ref}
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
      className="m-auto w-[26rem] max-w-[90vw] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-200 backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 id="settings-title" className="text-sm font-semibold">Settings</h2>
        <button type="button" aria-label="Close settings" onClick={() => ref.current?.close()} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-5 p-4">
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-300">File format for new requests</legend>
          <div className="space-y-2">
            {FORMATS.map((f) => (
              <label key={f.id} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${settings.preferredFormat === f.id ? 'border-zinc-500 bg-zinc-900' : 'border-zinc-800 hover:border-zinc-700'}`}>
                <input type="radio" name="format" checked={settings.preferredFormat === f.id} onChange={() => onFormat(f.id)} className="mt-0.5" />
                <span>
                  <span className="block font-mono text-xs font-semibold">{f.label}</span>
                  <span className="block text-xs text-zinc-500">{f.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Existing files keep their format; both kinds can live in the same folder.</p>
        </fieldset>

        <div>
          <p className="mb-2 text-xs font-medium text-zinc-300">Workspace folder</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-400" title={settings.workspacePath ?? ''}>
              {settings.workspacePath ?? 'Not set'}
            </code>
            <button type="button" onClick={onChooseWorkspace} className="shrink-0 rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
              Change…
            </button>
          </div>
        </div>
      </div>
    </dialog>
  )
}
