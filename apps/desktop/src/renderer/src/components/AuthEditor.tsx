import { useState } from 'react'
import { applyAuth, detectAuth, noAuth, type Auth, type AuthKind } from '../auth'
import type { KeyValue } from '../request'

interface Props {
  headers: KeyValue[]
  onHeaders: (headers: KeyValue[]) => void
}

const KINDS: { id: AuthKind; label: string }[] = [
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic auth' }
]

const field =
  'w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600'

/** Edits the `Authorization` header through a form; the header stays visible in the Headers tab. */
export function AuthEditor({ headers, onHeaders }: Props) {
  // Remembered locally so a half-filled form does not snap back to "No auth" (an empty header reads as none).
  const [auth, setAuth] = useState<Auth>(() => detectAuth(headers))

  const change = (patch: Partial<Auth>) => {
    const next = { ...auth, ...patch }
    setAuth(next)
    onHeaders(applyAuth(headers, next))
  }

  if (auth.kind === 'custom') {
    return (
      <div className="space-y-3 p-4 text-xs text-zinc-400">
        <p>
          This request has an <code className="text-zinc-200">Authorization</code> header the helper can’t edit (for example Digest, or
          pre-encoded Basic credentials). Edit it in the Headers tab.
        </p>
        <button type="button" onClick={() => change({ ...noAuth(), kind: 'none' })} className="rounded-md border border-zinc-700 px-3 py-1.5 hover:bg-zinc-800">
          Replace with the auth helper
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-lg space-y-3 p-4 text-xs">
      <label className="block">
        <span className="mb-1 block font-medium text-zinc-300">Type</span>
        <select
          aria-label="Auth type"
          value={auth.kind}
          onChange={(e) => change({ kind: e.target.value as AuthKind })}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5"
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>{k.label}</option>
          ))}
        </select>
      </label>

      {auth.kind === 'bearer' && (
        <label className="block">
          <span className="mb-1 block font-medium text-zinc-300">Token</span>
          <input
            aria-label="Bearer token"
            value={auth.token}
            onChange={(e) => change({ token: e.target.value })}
            placeholder="{{token}}"
            spellCheck={false}
            autoComplete="off"
            className={field}
          />
        </label>
      )}

      {auth.kind === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block font-medium text-zinc-300">Username</span>
            <input aria-label="Username" value={auth.username} onChange={(e) => change({ username: e.target.value })} placeholder="{{user}}" spellCheck={false} autoComplete="off" className={field} />
          </label>
          <label className="block">
            <span className="mb-1 block font-medium text-zinc-300">Password</span>
            <input aria-label="Password" value={auth.password} onChange={(e) => change({ password: e.target.value })} placeholder="{{password}}" spellCheck={false} autoComplete="off" className={field} />
          </label>
        </div>
      )}

      <p className="text-zinc-500">
        {auth.kind === 'none'
          ? 'Adds no Authorization header.'
          : 'Written to the Authorization header of the request file, so use {{variables}} to keep real credentials out of git.'}
      </p>
    </div>
  )
}
