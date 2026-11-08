import { useCallback, useEffect, useState } from 'react'
import type { McpActivity, McpApproval, McpStatus } from '@shared/api'

const MAX_SHOWN = 100

/** Live state of the opt-in MCP server: its status plus calls agents make while the panel is open. */
export function useMcp(onError: (e: unknown) => void) {
  const [status, setStatus] = useState<McpStatus | null>(null)

  useEffect(() => {
    let alive = true
    window.deadletter.mcp.status().then((s) => alive && setStatus(s), onError)
    const off = window.deadletter.mcp.onActivity((entry: McpActivity) =>
      setStatus((s) => (s ? { ...s, activity: [...s.activity, entry].slice(-MAX_SHOWN) } : s))
    )
    return () => {
      alive = false
      off()
    }
  }, [onError])

  const run = useCallback(
    async (call: () => Promise<McpStatus>) => {
      try {
        setStatus(await call())
      } catch (e) {
        onError(e)
      }
    },
    [onError]
  )

  return {
    status,
    setEnabled: (enabled: boolean) => run(() => window.deadletter.mcp.setEnabled(enabled)),
    setApproval: (approval: McpApproval) => run(() => window.deadletter.mcp.configure({ approval })),
    setPort: (port: number) => run(() => window.deadletter.mcp.configure({ port })),
    regenerateToken: () => run(() => window.deadletter.mcp.regenerateToken())
  }
}
