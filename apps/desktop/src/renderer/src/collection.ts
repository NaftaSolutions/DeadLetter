import type { TreeNode } from '@shared/api'

export interface TreeItem {
  node: TreeNode
  children: TreeItem[]
}

export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

const byKindThenName = (a: TreeItem, b: TreeItem): number =>
  a.node.kind === b.node.kind
    ? a.node.name.localeCompare(b.node.name, undefined, { sensitivity: 'base', numeric: true })
    : a.node.kind === 'folder'
      ? -1
      : 1

/** Turns the engine's flat, path-addressed list into a tree (folders first, then A-Z). */
export function buildTree(nodes: TreeNode[]): TreeItem[] {
  const items = new Map<string, TreeItem>(nodes.map((node) => [node.path, { node, children: [] }]))
  const roots: TreeItem[] = []
  for (const item of items.values()) {
    const parent = items.get(parentOf(item.node.path))
    ;(parent ? parent.children : roots).push(item)
  }
  const sort = (list: TreeItem[]): TreeItem[] => {
    list.sort(byKindThenName)
    list.forEach((i) => sort(i.children))
    return list
  }
  return sort(roots)
}
