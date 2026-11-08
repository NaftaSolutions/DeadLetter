import type { Environment, RequestFile, RequestPayload, ResponsePayload, StreamEvent, TreeNode } from '@deadletter/engine'

export type {
  EnvVariable,
  Environment,
  HeaderEntry,
  RequestFile,
  RequestHeader,
  RequestPayload,
  ResponsePayload,
  StreamEvent,
  TreeNode
} from '@deadletter/engine'

/** What an import produced; shown to the user once it has been written to the workspace. */
export interface ImportOutcome {
  /** `postman`, `insomnia` or `openapi`. */
  source: string
  name: string
  /** Workspace-relative folder the requests were written to. */
  folder: string
  written: number
  /** Names of the environments created from imported variables. */
  environments: string[]
  warnings: string[]
}

/** `sse` streams a normal HTTP response; `ws` is a WebSocket. */
export type StreamKind = 'sse' | 'ws'

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
  streamOpen: 'stream:open',
  streamSend: 'stream:send',
  streamClose: 'stream:close',
  pickFile: 'dialog:pickFile',
  /** main -> renderer push: something happened on a stream session. */
  streamEvent: 'stream:event',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChooseWorkspace: 'settings:chooseWorkspace',
  interopImportFile: 'interop:importFile',
  interopImportFolder: 'interop:importFolder',
  interopImportCurl: 'interop:importCurl',
  interopCopyCurl: 'interop:copyCurl',
  interopExportPostman: 'interop:exportPostman',
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

  /** Long-lived connections. The caller picks the session id; events for it arrive through `onEvent`. */
  stream: {
    /** Resolves once the session is started (connection progress arrives as events); rejects on invalid input. */
    open(id: number, kind: StreamKind, req: RequestPayload): Promise<void>
    /** Sends a text message on an open WebSocket session. */
    send(id: number, text: string): Promise<void>
    close(id: number): Promise<void>
    onEvent(listener: (event: StreamEvent) => void): () => void
  }

  /** Native file picker; resolves with the absolute path, or null if cancelled. */
  pickFile(): Promise<string | null>

  /** Tells the main process whether closing the window would lose unsaved edits. */
  setDirty(dirty: boolean): void

  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    /** Opens a native folder picker; resolves with the (possibly unchanged) settings. */
    chooseWorkspace(): Promise<Settings>
  }

  /** Moving requests between DeadLetter and other tools. */
  interop: {
    /** Native file picker, then a Postman / Insomnia / OpenAPI / Hoppscotch / HAR / .http file is written to a new workspace folder (plus environments). Null if cancelled. */
    importFile(): Promise<ImportOutcome | null>
    /** Native folder picker, then a Bruno collection folder is written to a new workspace folder (plus environments). Null if cancelled. */
    importFolder(): Promise<ImportOutcome | null>
    /** Creates a request in the workspace root from a pasted cURL command; resolves with its path. */
    importCurl(command: string): Promise<string>
    /** Copies the request as a cURL command (variables of the active environment filled in); resolves with the text. */
    copyCurl(request: RequestFile): Promise<string>
    /** Native save dialog, then the whole workspace as a Postman v2.1 collection. Resolves with the file path, or null if cancelled. */
    exportPostman(): Promise<string | null>
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
