// Trimmed-down Monaco: the core editor plus only the features a read-only response viewer
// needs (find, folding, bracket matching, copy, context menu) and the languages APIs
// actually return. Loaded lazily, see CodeViewer.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter'
import { jsonDefaults } from 'monaco-editor/language/json/monaco.contribution'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/html/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'json' ? new JsonWorker() : new EditorWorker())
}

// Responses are data, not documents under edit: no schema fetching, no squiggles.
jsonDefaults.setDiagnosticsOptions({ validate: false, schemaValidation: 'ignore' })

monaco.editor.defineTheme('deadletter', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#09090b',
    'editorGutter.background': '#09090b',
    'editor.lineHighlightBackground': '#18181b',
    'editorLineNumber.foreground': '#52525b',
    'editorLineNumber.activeForeground': '#a1a1aa'
  }
})

export { monaco }
