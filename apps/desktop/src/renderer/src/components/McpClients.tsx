import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpClientId, McpClientInfo } from '@shared/api'

interface Props {
  /** Changes whenever installed configs would be out of date (server restarted, token replaced). */
  refreshKey: string
  onError: (e: unknown) => void
}

/** One row per tool DeadLetter can register itself with. Nothing is written until a button is pressed. */
export function McpClients({ refreshKey, onError }: Props) {
  const [clients, setClients] = useState<McpClientInfo[] | null>(null)
  const [busy, setBusy] = useState<McpClientId | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // Listing runs the `claude` CLI, so replies can arrive out of order; only the latest request may update the list.
  const latest = useRef(0)
  const load = useCallback(() => {
    const mine = ++latest.current
    window.deadletter.mcp.clients().then(
      (list) => mine === latest.current && setClients(list),
      (e) => mine === latest.current && onError(e)
    )
  }, [onError])
  useEffect(load, [load, refreshKey])

  const act = async (id: McpClientId, action: 'installClient' | 'uninstallClient') => {
    setBusy(id)
    setMessage(null)
    try {
      const r = await window.deadletter.mcp[action](id)
      setMessage({ ok: r.ok, text: r.message })
      load()
    } catch (e) {
      onError(e)
    } finally {
      setBusy(null)
    }
  }

  if (!clients) return null
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-300">Connect an AI tool</p>
      <ul aria-label="AI tools" className="space-y-1.5">
        {clients.map((c) => (
          <li key={c.id} className="rounded-md border border-zinc-800 p-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">{c.name}</span>
              {c.installed && <span className="rounded bg-emerald-950 px-1.5 text-[10px] text-emerald-400">installed</span>}
              {!c.detected && <span className="text-[10px] text-zinc-500">not found on this computer</span>}
              <span className="ml-auto flex gap-1.5">
                {c.installed && (
                  <button type="button" disabled={busy !== null} onClick={() => act(c.id, 'uninstallClient')} aria-label={`Remove from ${c.name}`} className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50">
                    Remove
                  </button>
                )}
                <button type="button" disabled={!c.detected || busy !== null} onClick={() => act(c.id, 'installClient')} aria-label={`${c.installed ? 'Update' : 'Install in'} ${c.name}`} className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50">
                  {busy === c.id ? 'Working…' : c.installed ? 'Update' : 'Install'}
                </button>
              </span>
            </div>
            <p className="mt-1 break-all text-[11px] text-zinc-500">{c.preview}</p>
          </li>
        ))}
      </ul>
      {message && (
        <p role="status" className={`mt-1.5 break-all text-xs ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>{message.text}</p>
      )}
      <p className="mt-1.5 text-[11px] text-zinc-500">Regenerating the token or changing the port makes installed tools stop working until you press Update.</p>
    </div>
  )
}
