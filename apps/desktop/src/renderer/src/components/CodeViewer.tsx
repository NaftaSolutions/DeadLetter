import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor/editor/editor.api'

export type ViewerLanguage = 'json' | 'xml' | 'html' | 'plaintext'

interface Props {
  value: string
  language: ViewerLanguage
  wrap: boolean
}

/** Read-only Monaco instance. Monaco is imported on first use to keep startup fast. */
export function CodeViewer({ value, language, wrap }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null)
  const latest = useRef({ value, language, wrap })
  latest.current = { value, language, wrap }

  useEffect(() => {
    let disposed = false
    let created: editor.IStandaloneCodeEditor | null = null
    void import('../monaco').then(({ monaco }) => {
      if (disposed || !host.current) return
      const { value, language, wrap } = latest.current
      created = monaco.editor.create(host.current, {
        value,
        language,
        theme: 'deadletter',
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: wrap ? 'on' : 'off',
        fontSize: 12,
        lineNumbersMinChars: 3,
        folding: true,
        renderLineHighlight: 'none',
        occurrencesHighlight: 'off',
        padding: { top: 8, bottom: 8 },
        ariaLabel: 'Response body'
      })
      instance.current = created
    })
    return () => {
      disposed = true
      instance.current = null
      created?.getModel()?.dispose()
      created?.dispose()
    }
  }, [])

  useEffect(() => {
    const ed = instance.current
    if (!ed) return
    const model = ed.getModel()
    if (model && model.getValue() !== value) model.setValue(value)
    void import('../monaco').then(({ monaco }) => {
      const m = ed.getModel()
      if (m) monaco.editor.setModelLanguage(m, language)
    })
    ed.updateOptions({ wordWrap: wrap ? 'on' : 'off' })
  }, [value, language, wrap])

  return <div ref={host} data-testid="code-viewer" className="h-full w-full" />
}
