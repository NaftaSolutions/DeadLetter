/// <reference types="vite/client" />
import type { DeadLetterApi } from '@shared/api'

declare global {
  interface Window {
    deadletter: DeadLetterApi
  }
}