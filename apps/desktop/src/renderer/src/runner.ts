import type { AssertionResult, TreeNode } from '@shared/api'
import { buildTree, type TreeItem } from './collection.ts'

/** Request files under `dir` ('' = the whole workspace), in the order the sidebar shows them. */
export function requestsUnder(nodes: TreeNode[], dir: string): TreeNode[] {
  const walk = (items: TreeItem[]): TreeNode[] =>
    items.flatMap((i) => (i.node.kind === 'folder' ? walk(i.children) : [i.node]))
  const find = (items: TreeItem[]): TreeItem[] | null => {
    for (const i of items) {
      if (i.node.path === dir) return i.children
      const hit = i.node.kind === 'folder' ? find(i.children) : null
      if (hit) return hit
    }
    return null
  }
  const tree = buildTree(nodes)
  return walk(dir === '' ? tree : (find(tree) ?? []))
}

/** What happened to one request in a run. */
export interface RunEntry {
  path: string
  name: string
  method: string
  /** Set once the response arrived. */
  status?: number
  timeMs?: number
  tests: AssertionResult[]
  /** Why the request could not be sent (or was skipped). */
  error?: string
  skipped?: boolean
}

export const entryPassed = (e: RunEntry): boolean => !e.error && e.tests.every((t) => t.passed)

export function summarize(entries: RunEntry[]): { total: number; passed: number; failed: number; skipped: number } {
  const skipped = entries.filter((e) => e.skipped).length
  const ran = entries.filter((e) => !e.skipped)
  const passed = ran.filter(entryPassed).length
  return { total: entries.length, passed, failed: ran.length - passed, skipped }
}

/** WebSocket connections never finish, so a run leaves them out. */
export const isStreamUrl = (url: string): boolean => /^\s*wss?:\/\//i.test(url)
