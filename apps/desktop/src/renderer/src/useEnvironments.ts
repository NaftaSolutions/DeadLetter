import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@shared/api'

/** Environment names for the current workspace; `reload` after the dialog changes them. */
export function useEnvironments(workspacePath: string | null | undefined, onError: (e: unknown) => void) {
  const [names, setNames] = useState<string[]>([])

  const reload = useCallback(async () => {
    try {
      setNames(await window.deadletter.environments.list())
    } catch (e) {
      onError(e)
    }
  }, [onError])

  useEffect(() => {
    void reload()
  }, [reload, workspacePath])

  const setActive = useCallback(
    async (activeEnvironment: Settings['activeEnvironment']): Promise<Settings | null> => {
      try {
        return await window.deadletter.settings.update({ activeEnvironment })
      } catch (e) {
        onError(e)
        return null
      }
    },
    [onError]
  )

  return { names, reload, setActive }
}
