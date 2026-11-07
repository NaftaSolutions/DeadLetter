import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { RequestPayload, StreamEvent, StreamKind } from '@shared/api'
import { cleanError } from './errors'
import { connecting, idleStream, reduceStream, type StreamState } from './stream'

type Action = { type: 'event'; event: StreamEvent } | { type: 'start' } | { type: 'reset' } | { type: 'clear' }

function reducer(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case 'start':
      return connecting()
    case 'reset':
      return idleStream()
    case 'clear':
      return { ...state, entries: [], dropped: 0 }
    case 'event':
      return reduceStream(state, action.event)
  }
}

const local = (kind: string, data: string): StreamEvent => ({ id: 0, kind, atMs: 0, data })

/** One live connection at a time; the session id changes on every start so late events of an old one are ignored. */
export function useStream() {
  const idRef = useRef(0)
  const [state, dispatch] = useReducer(reducer, undefined, idleStream)

  useEffect(
    () =>
      window.deadletter.stream.onEvent((event) => {
        if (event.id === idRef.current) dispatch({ type: 'event', event })
      }),
    []
  )

  const stop = useCallback(() => {
    void window.deadletter.stream.close(idRef.current)
  }, [])

  const start = useCallback(async (kind: StreamKind, req: RequestPayload) => {
    void window.deadletter.stream.close(idRef.current)
    idRef.current += 1
    dispatch({ type: 'start' })
    try {
      await window.deadletter.stream.open(idRef.current, kind, req)
    } catch (e) {
      dispatch({ type: 'event', event: local('error', cleanError(e)) })
      dispatch({ type: 'event', event: local('close', 'Connection failed') })
    }
  }, [])

  const send = useCallback(async (text: string): Promise<boolean> => {
    try {
      await window.deadletter.stream.send(idRef.current, text)
      return true
    } catch (e) {
      dispatch({ type: 'event', event: local('error', cleanError(e)) })
      return false
    }
  }, [])

  /** Drops the connection and the log (switching requests). */
  const reset = useCallback(() => {
    void window.deadletter.stream.close(idRef.current)
    idRef.current += 1
    dispatch({ type: 'reset' })
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  return { state, start, stop, send, reset, clear }
}
