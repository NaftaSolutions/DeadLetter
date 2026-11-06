import { useEffect, useState } from 'react'
import type { ResponsePayload } from '@shared/api'
import type { ViewerLanguage } from './components/CodeViewer'
import { LARGE_BODY_CHARS } from './largeBody'

const contentType = (res: ResponsePayload): string =>
  res.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? ''

/**
 * Text and language for the body viewer. JSON is pretty-printed by the Rust engine on a worker
 * thread, so a large payload never blocks the UI; until it arrives the raw text is shown.
 * Very large bodies are not formatted automatically: the pretty copy would double the memory held
 * by the viewer, so the user asks for it (`format`).
 */
export function useResponseBody(res: ResponsePayload, raw: boolean) {
  const [pretty, setPretty] = useState<string | null>(null)
  const [requested, setRequested] = useState(false)
  const type = contentType(res)
  const maybeJson = res.body.length > 0 && (type.includes('json') || /^\s*[{[]/.test(res.body))
  const large = res.body.length > LARGE_BODY_CHARS
  const wanted = maybeJson && (!large || requested)

  useEffect(() => {
    setRequested(false)
  }, [res.body])

  useEffect(() => {
    setPretty(null)
    if (!wanted) return
    let stale = false
    window.deadletter.formatJson(res.body).then(
      (formatted) => {
        if (!stale) setPretty(formatted)
      },
      () => {}
    )
    return () => {
      stale = true
    }
  }, [res.body, wanted])

  let language: ViewerLanguage = 'plaintext'
  if (pretty !== null || type.includes('json')) language = 'json'
  else if (type.includes('xml')) language = 'xml'
  else if (type.includes('html')) language = 'html'

  return {
    text: !raw && pretty !== null ? pretty : res.body,
    language,
    canPrettify: pretty !== null,
    large,
    needsFormat: maybeJson && large && !requested,
    format: () => setRequested(true)
  }
}
