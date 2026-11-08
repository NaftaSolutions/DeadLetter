import { useEffect, useRef, useState } from 'react'
import type { McpApprovalRequest } from '@shared/api'

/** Asks the user about requests an agent wants to send. Mounted once so prompts appear whatever is on screen. */
export function McpApprovalDialog() {
  const [queue, setQueue] = useState<McpApprovalRequest[]>([])
  const ref = useRef<HTMLDialogElement>(null)
  const current = queue[0]

  useEffect(() => {
    const offAsk = window.deadletter.mcp.onApproval((r) => setQueue((q) => [...q, r]))
    const offGone = window.deadletter.mcp.onApprovalExpired((id) => setQueue((q) => q.filter((r) => r.id !== id)))
    return () => {
      offAsk()
      offGone()
    }
  }, [])

  useEffect(() => {
    const dialog = ref.current
    if (current && dialog && !dialog.open) dialog.showModal()
    if (!current && dialog?.open) dialog.close()
  }, [current])

  const answer = (allow: boolean, remember = false) => {
    if (!current) return
    const { id } = current
    setQueue((q) => q.filter((r) => r.id !== id))
    void window.deadletter.mcp.answerApproval(id, allow, remember)
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="mcp-approval-title"
      // Escape counts as "no": an unanswered agent must never be able to send.
      onCancel={(e) => {
        e.preventDefault()
        answer(false)
      }}
      className="m-auto w-[28rem] max-w-[90vw] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-200 backdrop:bg-black/60"
    >
      {current && (
        <div className="space-y-3 p-4">
          <h2 id="mcp-approval-title" className="text-sm font-semibold">An AI agent wants to send a request</h2>
          <code className="block break-all rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300">{current.detail}</code>
          {queue.length > 1 && <p className="text-xs text-zinc-500">{queue.length - 1} more waiting</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => answer(false)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">Deny</button>
            <button type="button" onClick={() => answer(true, true)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800">Allow for this session</button>
            <button type="button" autoFocus onClick={() => answer(true)} className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white">Allow once</button>
          </div>
        </div>
      )}
    </dialog>
  )
}
