import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings, TreeNode } from '@shared/api'

/** Settings plus the collection listing, kept fresh by the engine's file watcher. */
export function useWorkspace(onError: (e: unknown) => void) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [nodes, setNodes] = useState<TreeNode[]>([])

  // Listings can resolve out of order (watcher events, explicit refreshes); only the latest request may win.
  const latest = useRef(0)
  const refresh = useCallback(async () => {
    const id = ++latest.current
    try {
      const listing = await window.deadletter.collection.list()
      if (id === latest.current) setNodes(listing)
    } catch (e) {
      onError(e)
    }
  }, [onError])

  useEffect(() => {
    window.deadletter.settings.get().then(setSettings, onError)
  }, [onError])

  useEffect(() => {
    void refresh()
    return window.deadletter.collection.onChanged(() => void refresh())
  }, [refresh, settings?.workspacePath])

  const chooseWorkspace = useCallback(async () => {
    try {
      setSettings(await window.deadletter.settings.chooseWorkspace())
    } catch (e) {
      onError(e)
    }
  }, [onError])

  const setPreferredFormat = useCallback(
    async (preferredFormat: Settings['preferredFormat']) => {
      try {
        setSettings(await window.deadletter.settings.update({ preferredFormat }))
      } catch (e) {
        onError(e)
      }
    },
    [onError]
  )

  return { settings, setSettings, nodes, refresh, chooseWorkspace, setPreferredFormat }
}
