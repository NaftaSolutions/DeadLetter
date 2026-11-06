import type { Environment, RequestFile, RequestPayload, ResponsePayload, TreeNode } from '@deadletter/engine'

export type {
  EnvVariable,
  Environment,
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
  /** Name of the environment whose variables are applied to requests, or null for none. */
  activeEnvironment: string | null
}

/** Contract between preload (producer) and renderer (consumer). */
export const IPC = {
  ping: 'engine:ping',
  executeRequest: 'engine:executeRequest',
  formatJson: 'engine:formatJson',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChooseWorkspace: 'settings:chooseWorkspace',
  environmentList: 'environment:list',
  environmentRead: 'environment:read',
  environmentWrite: 'environment:write',
  environmentDelete: 'environment:delete',
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

  /** Pretty-prints JSON on a Rust worker thread; resolves to null when the text is not valid JSON. */
  formatJson(text: string): Promise<string | null>

  /** Tells the main process whether closing the window would lose unsaved edits. */
  setDirty(dirty: boolean): void

  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    /** Opens a native folder picker; resolves with the (possibly unchanged) settings. */
    chooseWorkspace(): Promise<Settings>
  }

  /** Environments live in `.deadletter/environments/` of the workspace; secrets stay out of git. */
  environments: {
    list(): Promise<string[]>
    /** Includes secret values (the editor needs them). */
    read(name: string): Promise<Environment>
    write(environment: Environment): Promise<void>
    delete(name: string): Promise<void>
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
