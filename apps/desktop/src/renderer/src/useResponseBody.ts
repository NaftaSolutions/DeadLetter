import { useEffect, useState } from 'react'
import type { ResponsePayload } from '@shared/api'
import type { ViewerLanguage } from './components/CodeViewer'

const contentType = (res: ResponsePayload): string =>
  res.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? ''

/**
 * Text and language for the body viewer. JSON is pretty-printed by the Rust engine on a worker
 * thread, so a large payload never blocks the UI; until it arrives the raw text is shown.
 */
export function useResponseBody(res: ResponsePayload, raw: boolean) {
  const [pretty, setPretty] = useState<string | null>(null)
  const type = contentType(res)
  const maybeJson = res.body.length > 0 && (type.includes('json') || /^\s*[{[]/.test(res.body))

  useEffect(() => {
    setPretty(null)
    if (!maybeJson) return
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
  }, [res.body, maybeJson])

  let language: ViewerLanguage = 'plaintext'
  if (pretty !== null || type.includes('json')) language = 'json'
  else if (type.includes('xml')) language = 'xml'
  else if (type.includes('html')) language = 'html'

  return { text: !raw && pretty !== null ? pretty : res.body, language, canPrettify: pretty !== null }
}
