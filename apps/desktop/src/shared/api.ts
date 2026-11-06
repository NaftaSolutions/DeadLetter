/** Contract between preload (producer) and renderer (consumer). */
export const IPC = {
  ping: 'engine:ping'
} as const

export interface DeadLetterApi {
  /** Calls the native Rust `ping()` via the main process. */
  ping(): Promise<string>
}