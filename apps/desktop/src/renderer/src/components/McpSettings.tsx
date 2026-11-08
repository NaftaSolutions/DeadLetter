import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { McpApproval, McpStatus } from '@shared/api'
import { useMcp } from '../useMcp'
import { McpClients } from './McpClients'

const APPROVALS: { id: McpApproval; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask me', hint: 'Approve each request an agent wants to send, or allow it for the session.' },
  { id: 'always', label: 'Always allow', hint: 'Agents can send saved requests without asking.' },
  { id: 'readonly', label: 'Read-only', hint: 'Agents can browse requests but cannot send anything.' }
]

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1200)
    } catch {
      /* clipboard can be unavailable */
    }
  }
  return (
    <button type="button" onClick={copy} aria-label={label} className="shrink-0 rounded-md border border-zinc-700 px-2 py-1.5 text-xs hover:bg-zinc-800">
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function Field({ label, shown, value, copyLabel }: { label: string; shown: string; value: string; copyLabel: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] text-zinc-500">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-400">{shown}</code>
        <CopyButton text={value} label={copyLabel} />
      </div>
    </div>
  )
}

/** The command that registers this server with Claude Code; other clients take the same URL and header. */
export function claudeCodeCommand(s: McpStatus): string {
  return `claude mcp add --transport http deadletter ${s.url} --header "Authorization: Bearer ${s.token}"`
}

function Activity({ status }: { status: McpStatus }) {
  const recent = status.activity.slice(-20).reverse()
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-zinc-300">Activity</p>
      {recent.length === 0 ? (
        <p className="text-xs text-zinc-500">Nothing yet. Calls from agents show up here.</p>
      ) : (
        <ul aria-label="MCP activity" className="max-h-40 space-y-1 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2">
          {recent.map((a, i) => (
            <li key={`${a.at}-${i}`} className="flex gap-2 font-mono text-[11px]">
              <span className={a.outcome === 'ok' ? 'text-emerald-400' : 'text-red-400'}>{a.outcome === 'ok' ? 'ok' : 'err'}</span>
              <span className="text-zinc-300">{a.tool}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-500" title={a.detail}>{a.detail}</span>
              <span className="text-zinc-600">{a.ms}ms</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function McpSettings({ onError }: { onError: (e: unknown) => void }) {
  const { status, setEnabled, setApproval, setPort, regenerateToken } = useMcp(onError)
  const [port, setPortText] = useState<string | null>(null)
  if (!status) return null

  const commitPort = () => {
    const n = Number(port)
    setPortText(null)
    if (port !== null && n !== status.port) void setPort(n)
  }

  return (
    <section aria-labelledby="mcp-title" className="space-y-3 border-t border-zinc-800 pt-5">
      <h3 id="mcp-title" className="text-xs font-medium text-zinc-300">AI agent access (MCP)</h3>

      {!status.enabled ? (
        <>
          <p className="text-xs text-zinc-500">
            Off. When enabled, DeadLetter runs a server on this computer only (127.0.0.1) that AI tools such as Claude Code can use to list your saved requests, read them and,
            with your approval, send them. Secret environment values are never shared with agents. Nothing leaves your machine except the requests you approve.
          </p>
          <button type="button" onClick={() => setEnabled(true)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">
            Enable MCP server
          </button>
          {status.error && <p role="alert" className="text-xs text-red-400">{status.error}</p>}
        </>
      ) : (
        <>
          <p className={`text-xs ${status.running ? 'text-emerald-400' : 'text-amber-400'}`} role="status">
            {status.running ? `Running on ${status.url}` : 'Not running'}
          </p>
          {status.error && <p role="alert" className="text-xs text-red-400">{status.error}</p>}

          <fieldset>
            <legend className="mb-1 text-xs text-zinc-400">When an agent wants to send a request</legend>
            <div className="space-y-1.5">
              {APPROVALS.map((a) => (
                <label key={a.id} className={`flex cursor-pointer items-start gap-3 rounded-md border p-2 ${status.approval === a.id ? 'border-zinc-500 bg-zinc-900' : 'border-zinc-800 hover:border-zinc-700'}`}>
                  <input type="radio" name="mcp-approval" checked={status.approval === a.id} onChange={() => setApproval(a.id)} className="mt-0.5" />
                  <span>
                    <span className="block text-xs font-semibold">{a.label}</span>
                    <span className="block text-xs text-zinc-500">{a.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {status.running && <McpClients refreshKey={`${status.url}|${status.token}`} onError={onError} />}

          <Field label="Endpoint" shown={status.url} value={status.url} copyLabel="Copy endpoint" />
          <Field label="Token" shown={'•'.repeat(24)} value={status.token} copyLabel="Copy token" />
          <Field
            label="Or add it by hand (other clients: same URL and an Authorization: Bearer header)"
            shown="claude mcp add --transport http deadletter …"
            value={claudeCodeCommand(status)}
            copyLabel="Copy Claude Code command"
          />

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Port
              <input
                type="number"
                min={1024}
                max={65535}
                value={port ?? status.port}
                onChange={(e) => setPortText(e.target.value)}
                onBlur={commitPort}
                onKeyDown={(e) => e.key === 'Enter' && commitPort()}
                className="w-20 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs"
              />
            </label>
            <button type="button" onClick={regenerateToken} className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800">
              Regenerate token
            </button>
            <button type="button" onClick={() => setEnabled(false)} className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800">
              Disable
            </button>
          </div>

          <Activity status={status} />
        </>
      )}
    </section>
  )
}
