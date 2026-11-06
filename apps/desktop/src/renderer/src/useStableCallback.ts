import { useCallback, useRef } from 'react'

/**
 * A callback with a permanent identity that always runs the latest closure. Lets `memo`ed children
 * skip re-rendering on every keystroke while handlers still see current state.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}
