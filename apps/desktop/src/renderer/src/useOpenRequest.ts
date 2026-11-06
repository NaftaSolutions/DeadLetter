import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyDraft, fromFile, toFile, type RequestDraft } from './request'

const snapshot = (d: RequestDraft): string => JSON.stringify(toFile(d))

/**
 * The request currently being edited. `path === null` is an unsaved scratch request.
 * Tracks unsaved edits and quietly picks up external changes to the file (git pull,
 * another editor) as long as there are no local edits to lose.
 */
export function useOpenRequest(onError: (e: unknown) => void) {
  const [path, setPath] = useState<string | null>(null)
  const [draft, setDraft] = useState<RequestDraft>(emptyDraft)
  const [saved, setSaved] = useState(() => snapshot(emptyDraft()))
  const dirty = useMemo(() => path !== null && snapshot(draft) !== saved, [path, draft, saved])

  const pathRef = useRef(path)
  pathRef.current = path
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const load = useCallback(
    async (target: string): Promise<boolean> => {
      try {
        const next = fromFile(await window.deadletter.collection.read(target))
        setPath(target)
        setDraft(next)
        setSaved(snapshot(next))
        return true
      } catch (e) {
        onError(e)
        return false
      }
    },
    [onError]
  )

  const close = useCallback(() => {
    const next = emptyDraft()
    setPath(null)
    setDraft(next)
    setSaved(snapshot(next))
  }, [])

  const save = useCallback(async () => {
    const target = pathRef.current
    if (!target) return
    try {
      await window.deadletter.collection.write(target, toFile(draft))
      setSaved(snapshot(draft))
    } catch (e) {
      onError(e)
    }
  }, [draft, onError])

  /** Called when the workspace listing changes on disk. */
  const syncWithDisk = useCallback(
    async (existingPaths: Set<string>) => {
      const current = pathRef.current
      if (!current || dirtyRef.current) return
      try {
        const next = fromFile(await window.deadletter.collection.read(current))
        // The read is asynchronous: the request may have been closed, switched or edited meanwhile,
        // and applying stale disk content then would resurrect it or clobber the edit.
        if (pathRef.current !== current || dirtyRef.current) return
        // Keep editor row ids stable when nothing changed, so focus is not lost.
        if (snapshot(next) !== snapshot(draftRef.current)) {
          setDraft(next)
          setSaved(snapshot(next))
        }
      } catch {
        // Gone from disk (and from the listing): close it. Otherwise it is probably
        // mid-write and the next change event retries.
        if (!existingPaths.has(current) && pathRef.current === current) close()
      }
    },
    [close]
  )
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    window.deadletter.setDirty(dirty)
  }, [dirty])

  const patch = useCallback((p: Partial<RequestDraft>) => setDraft((d) => ({ ...d, ...p })), [])

  return { path, draft, dirty, patch, load, close, save, syncWithDisk, setPath }
}
