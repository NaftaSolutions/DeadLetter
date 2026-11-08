import { memo, useMemo, useState } from 'react'
import { FilePlus, FolderOpen, FolderPlus, Play } from 'lucide-react'
import type { Settings, TreeNode } from '@shared/api'
import { buildTree } from '../collection'
import { NewEntryRow, TreeRow, type Editing, type TreeActions } from './TreeRow'

interface Props {
  settings: Settings
  nodes: TreeNode[]
  activePath: string | null
  onOpen: (path: string) => void
  onChooseWorkspace: () => void
  onCreateRequest: (dir: string, name: string) => Promise<void>
  onCreateFolder: (dir: string, name: string) => Promise<void>
  onRename: (path: string, name: string) => Promise<void>
  onDelete: (path: string, isFolder: boolean) => Promise<void>
  onRun: (dir: string, name: string) => void
}

const headerBtn = 'rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'

export const Sidebar = memo(function Sidebar({ settings, nodes, activePath, onOpen, onChooseWorkspace, onCreateRequest, onCreateFolder, onRename, onDelete, onRun }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<Editing | null>(null)
  const tree = useMemo(() => buildTree(nodes), [nodes])

  if (!settings.workspacePath) {
    return (
      <aside aria-label="Collection" className="flex w-64 shrink-0 flex-col items-center justify-center gap-3 border-r border-zinc-800 p-6 text-center">
        <FolderOpen className="size-6 text-zinc-600" />
        <p className="text-xs leading-relaxed text-zinc-400">
          Pick a folder to keep your requests in. They are saved as plain {settings.preferredFormat === 'http' ? '.http' : '.json'} files you can commit to git.
        </p>
        <button type="button" onClick={onChooseWorkspace} className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-white">
          Open folder…
        </button>
      </aside>
    )
  }

  const finish = <A extends unknown[]>(fn: (...args: A) => Promise<void>) => async (...args: A) => {
    setEditing(null)
    await fn(...args)
  }
  const actions: TreeActions = {
    activePath,
    expanded,
    editing,
    onToggle: (path, forceOpen) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (forceOpen || !next.has(path)) next.add(path)
        else next.delete(path)
        return next
      }),
    onOpen,
    onEdit: setEditing,
    onRun,
    onRename: finish(onRename),
    onCreateRequest: finish(async (dir: string, name: string) => {
      if (dir) setExpanded((prev) => new Set(prev).add(dir))
      await onCreateRequest(dir, name)
    }),
    onCreateFolder: finish(async (dir: string, name: string) => {
      if (dir) setExpanded((prev) => new Set(prev).add(dir))
      await onCreateFolder(dir, name)
    }),
    onDelete: (path, name, isFolder) => {
      const what = isFolder ? `folder "${name}" and everything in it` : `request "${name}"`
      if (window.confirm(`Delete ${what}? This cannot be undone.`)) void onDelete(path, isFolder)
    }
  }

  const folderName = settings.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? settings.workspacePath
  const rootAdding = editing && editing.kind !== 'rename' && editing.dir === '' ? editing : null

  return (
    <aside aria-label="Collection" className="flex w-64 shrink-0 flex-col border-r border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800 py-1.5 pl-3 pr-1.5">
        <button type="button" onClick={onChooseWorkspace} title={`${settings.workspacePath}\nClick to change folder`} className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100">
          <FolderOpen className="size-3.5 shrink-0 text-zinc-500" />
          <span className="truncate">{folderName}</span>
        </button>
        <span className="flex shrink-0">
          <button type="button" className={headerBtn} aria-label="Run all requests" title="Run all requests" onClick={() => onRun('', folderName)}>
            <Play className="size-3.5" />
          </button>
          <button type="button" className={headerBtn} aria-label="New request" title="New request" onClick={() => setEditing({ kind: 'new-request', dir: '' })}>
            <FilePlus className="size-3.5" />
          </button>
          <button type="button" className={headerBtn} aria-label="New folder" title="New folder" onClick={() => setEditing({ kind: 'new-folder', dir: '' })}>
            <FolderPlus className="size-3.5" />
          </button>
        </span>
      </div>

      <ul role="tree" aria-label="Requests" className="min-h-0 flex-1 overflow-auto py-1">
        {rootAdding && <NewEntryRow editing={rootAdding} depth={0} a={actions} />}
        {tree.map((item) => (
          <TreeRow key={item.node.path} item={item} depth={0} a={actions} />
        ))}
        {tree.length === 0 && !rootAdding && (
          <li className="px-4 py-6 text-center text-xs text-zinc-600">No requests yet. Use the + button to create one.</li>
        )}
      </ul>
    </aside>
  )
})
