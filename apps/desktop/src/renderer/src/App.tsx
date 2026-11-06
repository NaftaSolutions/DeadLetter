import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings as SettingsIcon, X } from 'lucide-react'
import { EnvironmentDialog } from './components/EnvironmentDialog'
import { EnvironmentSelect } from './components/EnvironmentSelect'
import { RequestBar } from './components/RequestBar'
import { RequestPane } from './components/RequestPane'
import { RequestTitle } from './components/RequestTitle'
import { ResponsePane } from './components/ResponsePane'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { cleanError } from './errors'
import { StatusBadge, type EngineStatus } from './StatusBadge'
import { useEnvironments } from './useEnvironments'
import { useOpenRequest } from './useOpenRequest'
import { useSend } from './useSend'
import { useWorkspace } from './useWorkspace'

const DISCARD = 'You have unsaved changes in this request. Discard them?'

export function App() {
  const [engine, setEngine] = useState<EngineStatus>({ state: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showEnvs, setShowEnvs] = useState(false)

  const onError = useCallback((e: unknown) => setNotice(cleanError(e)), [])
  const { settings, setSettings, nodes, refresh, chooseWorkspace, setPreferredFormat } = useWorkspace(onError)
  const envs = useEnvironments(settings?.workspacePath, onError)
  const { path, draft, dirty, patch, load, close, save, syncWithDisk, setPath } = useOpenRequest(onError)
  const { state, send, reset } = useSend()

  useEffect(() => {
    window.deadletter
      .ping()
      .then((message) => setEngine({ state: 'ok', message }))
      .catch((e: unknown) => setEngine({ state: 'error', message: String(e) }))
  }, [])

  // Pick up external edits (git pull, another editor) once the listing refreshes.
  useEffect(() => {
    void syncWithDisk(new Set(nodes.map((n) => n.path)))
  }, [nodes, syncWithDisk])

  const selectEnvironment = async (name: string | null) => {
    const next = await envs.setActive(name)
    if (next) setSettings(next)
  }

  const confirmDiscard =(): boolean => !dirty || window.confirm(DISCARD)

  const open = async (target: string) => {
    if (target === path || !confirmDiscard()) return
    if (await load(target)) {
      setNotice(null)
      reset()
    }
  }

  const createRequest = async (dir: string, name: string) => {
    if (!confirmDiscard()) return
    try {
      const created = await window.deadletter.collection.createRequest(dir, name)
      await load(created)
      reset()
      await refresh()
    } catch (e) {
      onError(e)
    }
  }

  const createFolder = async (dir: string, name: string) => {
    try {
      await window.deadletter.collection.createFolder(dir, name)
      await refresh()
    } catch (e) {
      onError(e)
    }
  }

  const rename = async (target: string, name: string) => {
    const isOpen = target === path
    const containsOpen = path !== null && path.startsWith(`${target}/`)
    if (isOpen && !confirmDiscard()) return
    try {
      const next = await window.deadletter.collection.rename(target, name)
      if (isOpen) await load(next)
      else if (containsOpen && path) setPath(next + path.slice(target.length))
      await refresh()
    } catch (e) {
      onError(e)
    }
  }

  const remove = async (target: string) => {
    try {
      await window.deadletter.collection.remove(target)
      if (path && (path === target || path.startsWith(`${target}/`))) {
        close()
        reset()
      }
      await refresh()
    } catch (e) {
      onError(e)
    }
  }

  // Global shortcuts, wherever focus is (including inside the body textarea).
  const sendRef = useRef(() => {})
  sendRef.current = () => {
    if (state.kind !== 'loading') void send(draft)
  }
  const saveRef = useRef(() => {})
  saveRef.current = () => {
    if (dirty) void save()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Enter' && mod) {
        e.preventDefault()
        sendRef.current()
      } else if (e.key.toLowerCase() === 's' && mod) {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-sm font-semibold tracking-tight">DeadLetter</span>
        <div className="flex items-center gap-2">
          {settings?.workspacePath && (
            <EnvironmentSelect
              names={envs.names}
              active={settings.activeEnvironment}
              onSelect={(n) => void selectEnvironment(n)}
              onManage={() => setShowEnvs(true)}
            />
          )}
          <StatusBadge status={engine} />
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setShowSettings(true)}
            className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <SettingsIcon className="size-4" />
          </button>
        </div>
      </header>

      {notice && (
        <div role="alert" className="flex items-start justify-between gap-3 border-b border-red-900 bg-red-950/40 px-4 py-2 text-xs text-red-300">
          <span className="min-w-0 break-words">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0 text-red-400 hover:text-red-200">
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {settings && (
          <Sidebar
            settings={settings}
            nodes={nodes}
            activePath={path}
            onOpen={open}
            onChooseWorkspace={chooseWorkspace}
            onCreateRequest={createRequest}
            onCreateFolder={createFolder}
            onRename={rename}
            onDelete={remove}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <RequestTitle name={draft.name} path={path} dirty={dirty} onSave={() => void save()} />
          <RequestBar
            method={draft.method}
            url={draft.url}
            loading={state.kind === 'loading'}
            onMethod={(method) => patch({ method })}
            onUrl={(url) => patch({ url })}
            onSend={() => sendRef.current()}
          />
          <main className="flex min-h-0 flex-1 flex-col">
            <RequestPane draft={draft} onChange={patch} />
            <ResponsePane state={state} />
          </main>
        </div>
      </div>

      {showEnvs && (
        <EnvironmentDialog
          names={envs.names}
          initial={settings?.activeEnvironment ?? null}
          onChanged={envs.reload}
          onDeleted={(n) => {
            if (settings?.activeEnvironment === n) setSettings({ ...settings, activeEnvironment: null })
          }}
          onClose={() => setShowEnvs(false)}
        />
      )}

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          onFormat={setPreferredFormat}
          onChooseWorkspace={chooseWorkspace}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
