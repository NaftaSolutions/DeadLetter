import { ChevronRight, FilePlus, Play, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'
import type { TreeItem } from '../collection'
import { InlineInput } from './InlineInput'

export type Editing =
  | { kind: 'rename'; path: string }
  | { kind: 'new-request'; dir: string }
  | { kind: 'new-folder'; dir: string }

export interface TreeActions {
  activePath: string | null
  expanded: Set<string>
  editing: Editing | null
  onToggle: (path: string, forceOpen?: boolean) => void
  onOpen: (path: string) => void
  onEdit: (e: Editing | null) => void
  onRename: (path: string, name: string) => void
  onCreateRequest: (dir: string, name: string) => void
  onCreateFolder: (dir: string, name: string) => void
  onDelete: (path: string, name: string, isFolder: boolean) => void
  onRun: (path: string, name: string) => void
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-emerald-400',
  POST: 'text-amber-400',
  PUT: 'text-sky-400',
  PATCH: 'text-violet-400',
  DELETE: 'text-red-400'
}

const iconBtn =
  'rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100'

/** Inline "new ..." row shown at the top of a folder's children. */
export function NewEntryRow({ editing, depth, a }: { editing: Editing; depth: number; a: TreeActions }) {
  if (editing.kind === 'rename') return null
  const isFolder = editing.kind === 'new-folder'
  return (
    <div className="flex items-center gap-1.5 py-0.5 pr-2" style={{ paddingLeft: 8 + depth * 14 + 18 }}>
      <InlineInput
        label={isFolder ? 'New folder name' : 'New request name'}
        placeholder={isFolder ? 'Folder name' : 'Request name'}
        onCancel={() => a.onEdit(null)}
        onCommit={(name) => (isFolder ? a.onCreateFolder(editing.dir, name) : a.onCreateRequest(editing.dir, name))}
      />
    </div>
  )
}

export function TreeRow({ item, depth, a }: { item: TreeItem; depth: number; a: TreeActions }) {
  const { node } = item
  const isFolder = node.kind === 'folder'
  const open = a.expanded.has(node.path)
  const active = a.activePath === node.path
  const renaming = a.editing?.kind === 'rename' && a.editing.path === node.path
  const pad = { paddingLeft: 8 + depth * 14 }
  const adding = a.editing && a.editing.kind !== 'rename' && a.editing.dir === node.path ? a.editing : null

  return (
    <li role="treeitem" aria-expanded={isFolder ? open : undefined} aria-selected={active}>
      <div
        className={`group flex items-center gap-1.5 py-0.5 pr-1.5 ${
          active ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'
        }`}
        style={pad}
      >
        {renaming ? (
          <InlineInput
            initial={node.name}
            label="New name"
            placeholder="Name"
            onCancel={() => a.onEdit(null)}
            onCommit={(name) => a.onRename(node.path, name)}
          />
        ) : (
          <button
            type="button"
            onClick={() => (isFolder ? a.onToggle(node.path) : a.onOpen(node.path))}
            title={node.path}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left text-xs"
          >
            {isFolder ? (
              <>
                <ChevronRight className={`size-3 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`} />
                {open ? <FolderOpen className="size-3.5 shrink-0 text-zinc-500" /> : <Folder className="size-3.5 shrink-0 text-zinc-500" />}
              </>
            ) : (
              <>
                <span className="size-3 shrink-0" />
                <span className={`w-9 shrink-0 font-mono text-[10px] font-semibold ${METHOD_COLOR[node.method ?? ''] ?? 'text-zinc-500'}`}>
                  {(node.method ?? '???').slice(0, 5)}
                </span>
              </>
            )}
            <span className="truncate">{node.name}</span>
            {!isFolder && node.format ? (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">.{node.format}</span>
            ) : null}
          </button>
        )}

        {!renaming && (
          <span className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {isFolder && (
              <>
                <button type="button" className={iconBtn} aria-label={`Run ${node.name}`} title="Run all requests in this folder" onClick={() => a.onRun(node.path, node.name)}>
                  <Play className="size-3.5" />
                </button>
                <button type="button" className={iconBtn} aria-label={`New request in ${node.name}`} title="New request" onClick={() => { a.onToggle(node.path, true); a.onEdit({ kind: 'new-request', dir: node.path }) }}>
                  <FilePlus className="size-3.5" />
                </button>
                <button type="button" className={iconBtn} aria-label={`New folder in ${node.name}`} title="New folder" onClick={() => { a.onToggle(node.path, true); a.onEdit({ kind: 'new-folder', dir: node.path }) }}>
                  <FolderPlus className="size-3.5" />
                </button>
              </>
            )}
            <button type="button" className={iconBtn} aria-label={`Rename ${node.name}`} title="Rename" onClick={() => a.onEdit({ kind: 'rename', path: node.path })}>
              <Pencil className="size-3.5" />
            </button>
            <button type="button" className={iconBtn} aria-label={`Delete ${node.name}`} title="Delete" onClick={() => a.onDelete(node.path, node.name, isFolder)}>
              <Trash2 className="size-3.5" />
            </button>
          </span>
        )}
      </div>

      {isFolder && open && (
        <ul role="group">
          {adding && <NewEntryRow editing={adding} depth={depth + 1} a={a} />}
          {item.children.map((child) => (
            <TreeRow key={child.node.path} item={child} depth={depth + 1} a={a} />
          ))}
        </ul>
      )}
    </li>
  )
}
