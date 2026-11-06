import type { RequestPayload, ResponsePayload } from '@deadletter/engine'

export type { HeaderEntry, RequestPayload, ResponsePayload } from '@deadletter/engine'

/** Contract between preload (producer) and renderer (consumer). */
export const IPC = {
  ping: 'engine:ping',
  executeRequest: 'engine:executeRequest'
} as const

export interface DeadLetterApi {
  /** Calls the native Rust `ping()` via the main process. */
  ping(): Promise<string>
  /** Runs an HTTP request in the Rust engine. Rejects with a readable message on failure. */
  executeRequest(req: RequestPayload): Promise<ResponsePayload>
}