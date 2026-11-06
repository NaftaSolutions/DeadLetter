import { useCallback, useRef, useState } from 'react'
import type { ResponsePayload } from '@shared/api'
import { cleanError } from './errors'
import { toPayload, type RequestDraft } from './request'

export type SendState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; response: ResponsePayload }
  | { kind: 'error'; message: string }

export function useSend() {
  const [state, setState] = useState<SendState>({ kind: 'idle' })
  const seq = useRef(0)

  const send = useCallback(async (draft: RequestDraft) => {
    if (!draft.url.trim()) return
    const id = ++seq.current
    setState({ kind: 'loading' })
    try {
      const response = await window.deadletter.executeRequest(toPayload(draft))
      if (id === seq.current) setState({ kind: 'done', response })
    } catch (e) {
      if (id === seq.current) setState({ kind: 'error', message: cleanError(e) })
    }
  }, [])

  /** Clears the response and ignores any request still in flight (used when switching requests). */
  const reset = useCallback(() => {
    seq.current++
    setState({ kind: 'idle' })
  }, [])

  return { state, send, reset }
}
