import type { AssertionResult, Environment, RequestFile, RequestPayload, ResponsePayload, StreamEvent, TreeNode } from '@deadletter/engine'

export type {
  AssertionResult,
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

/** `ask`: the user approves each agent-initiated send (or allows the session); `always`: no prompt; `readonly`: agents cannot send at all. */
export type McpApproval = 'ask' | 'always' | 'readonly'

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  approval: McpApproval
  /** Full endpoint, e.g. `http://127.0.0.1:39217/mcp`. */
  url: string
  /** Bearer token clients must send. Stored in the app's user-data folder, never in the workspace. */
  token: string
  /** Why the server could not start (port in use, no workspace...). */
  error: string | null
  /** Most recent agent calls, newest last. */
  activity: McpActivity[]
}

/** One finished agent tool call. */
export interface McpActivity {
  at: number
  tool: string
  detail: string
  outcome: 'ok' | 'error'
  ms: number
}

/** An agent wants to send a request and is waiting for the user. */
export interface McpApprovalRequest {
  id: number
  tool: string
  detail: string
}

export type McpClientId = 'claude-code' | 'cursor' | 'vscode'

/** A tool the MCP server can be registered with. */
export interface McpClientInfo {
  id: McpClientId
  name: string
  /** Found on this computer; only detected tools can be installed into. */
  detected: boolean
  /** DeadLetter is registered with it. */
  installed: boolean
  /** Exactly what installing does. */
  preview: string
}

export interface McpInstallResult {
  id: McpClientId
  ok: boolean
  message: string
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
  runAssertions: 'engine:runAssertions',
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
  setDirty: 'app:setDirty',
  mcpStatus: 'mcp:status',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpConfigure: 'mcp:configure',
  mcpRegenerateToken: 'mcp:regenerateToken',
  mcpAnswerApproval: 'mcp:answerApproval',
  mcpClients: 'mcp:clients',
  mcpInstallClient: 'mcp:installClient',
  mcpUninstallClient: 'mcp:uninstallClient',
  /** main -> renderer pushes */
  mcpActivity: 'mcp:activity',
  mcpApproval: 'mcp:approval',
  mcpApprovalExpired: 'mcp:approvalExpired'
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

  /** Checks a response against a request's assertions (variables of the active environment filled in). */
  runAssertions(assertions: string[], response: ResponsePayload): Promise<AssertionResult[]>

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

  /** Opt-in MCP server for AI agents. Off until the user enables it. */
  mcp: {
    status(): Promise<McpStatus>
    /** Starts or stops the server. */
    setEnabled(enabled: boolean): Promise<McpStatus>
    /** Changes the port and/or approval mode (restarts the server when needed). */
    configure(patch: { port?: number; approval?: McpApproval }): Promise<McpStatus>
    /** Invalidates the old token; connected clients must be reconfigured. */
    regenerateToken(): Promise<McpStatus>
    /** Tools DeadLetter can be registered with, and whether it already is. Needs the server running. */
    clients(): Promise<McpClientInfo[]>
    /** Registers (or updates) DeadLetter in that tool's user-level config. Rejects if the server is off. */
    installClient(id: McpClientId): Promise<McpInstallResult>
    uninstallClient(id: McpClientId): Promise<McpInstallResult>
    answerApproval(id: number, allow: boolean, remember: boolean): Promise<void>
    onActivity(listener: (entry: McpActivity) => void): () => void
    onApproval(listener: (request: McpApprovalRequest) => void): () => void
    /** The request with this id can no longer be answered (timeout, client left, server stopped). */
    onApprovalExpired(listener: (id: number) => void): () => void
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
