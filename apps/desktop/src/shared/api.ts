import type { RequestFile, RequestPayload, ResponsePayload, TreeNode } from '@deadletter/engine'

export type {
  HeaderEntry,
  RequestFile,
  RequestHeader,
  RequestPayload,
  ResponsePayload,
  TreeNode
} from '@deadletter/engine'

export type RequestFormat = 'json' | 'http'

export interface Settings {
  /** Absolute path of the folder that holds the collection, or null until the user picks one. */
  workspacePath: string | null
  /** Format used for newly created requests. Existing files keep theirs. */
  preferredFormat: RequestFormat
}

/** Contract between preload (producer) and renderer (consumer). */
export const IPC = {
  ping: 'engine:ping',
  executeRequest: 'engine:executeRequest',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChooseWorkspace: 'settings:chooseWorkspace',
  collectionList: 'collection:list',
  collectionRead: 'collection:read',
  collectionWrite: 'collection:write',
  collectionCreateRequest: 'collection:createRequest',
  collectionCreateFolder: 'collection:createFolder',
  collectionRename: 'collection:rename',
  collectionRemove: 'collection:remove',
  /** main -> renderer push: files in the workspace changed on disk. */
  collectionChanged: 'collection:changed',
  /** renderer -> main: whether the open request has unsaved edits (guards window close). */
  setDirty: 'app:setDirty'
} as const

export interface DeadLetterApi {
  /** Calls the native Rust `ping()` via the main process. */
  ping(): Promise<string>
  /** Runs an HTTP request in the Rust engine. Rejects with a readable message on failure. */
  executeRequest(req: RequestPayload): Promise<ResponsePayload>

  /** Tells the main process whether closing the window would lose unsaved edits. */
  setDirty(dirty: boolean): void

  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    /** Opens a native folder picker; resolves with the (possibly unchanged) settings. */
    chooseWorkspace(): Promise<Settings>
  }

  /** All paths are relative to the workspace and use `/`. The main process owns the root. */
  collection: {
    list(): Promise<TreeNode[]>
    read(path: string): Promise<RequestFile>
    write(path: string, request: RequestFile): Promise<void>
    /** Creates an empty request in the user's preferred format; resolves with its path. */
    createRequest(dir: string, name: string): Promise<string>
    createFolder(dir: string, name: string): Promise<string>
    rename(path: string, newName: string): Promise<string>
    remove(path: string): Promise<void>
    /** Fires (debounced) when the workspace changes on disk. Returns an unsubscribe function. */
    onChanged(listener: () => void): () => void
  }
}
