// Monaco ships no typings for these deep side-effect modules.
declare module 'monaco-editor/language/json/monaco.contribution' {
  export const jsonDefaults: {
    setDiagnosticsOptions(options: { validate?: boolean; schemaValidation?: 'ignore' | 'warning' | 'error' }): void
  }
}
