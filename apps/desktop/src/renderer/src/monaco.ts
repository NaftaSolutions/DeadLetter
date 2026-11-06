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
// Services that editor contributions pull in. They must be registered before the first editor
// is created, which the lazily loaded JSON language chunk would otherwise do too late.
import 'monaco-editor/editor/common/services/treeViewsDndService'
import 'monaco-editor/editor/contrib/codelens/browser/codeLensCache'
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsController'
import 'monaco-editor/editor/contrib/suggest/browser/suggestMemory'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/html/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

// Responses are data, not documents under edit, and the Rust engine already pretty-prints them.
// Monaco's JSON language service (1.6 MB + an 880 KB worker) would add only validation and
// formatting we switch off, so JSON gets a tokenizer and bracket rules; folding is indentation based.
monaco.languages.register({ id: 'json', aliases: ['JSON'], mimetypes: ['application/json'] })
monaco.languages.setLanguageConfiguration('json', {
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}', notIn: ['string'] }, { open: '[', close: ']', notIn: ['string'] }, { open: '"', close: '"', notIn: ['string'] }]
})
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}[\]]/, '@brackets'],
      [/[,:]/, 'delimiter']
    ]
  }
})

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
