import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RequestFormat, Settings } from '../shared/api'

const DEFAULTS: Settings = { workspacePath: null, preferredFormat: 'http', activeEnvironment: null }

const file = (): string => join(app.getPath('userData'), 'settings.json')

function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const preferredFormat: RequestFormat =
    r.preferredFormat === 'json' || r.preferredFormat === 'http' ? r.preferredFormat : DEFAULTS.preferredFormat
  const workspacePath =
    typeof r.workspacePath === 'string' && r.workspacePath ? r.workspacePath : DEFAULTS.workspacePath
  const activeEnvironment =
    typeof r.activeEnvironment === 'string' && r.activeEnvironment ? r.activeEnvironment : null
  return { workspacePath, preferredFormat, activeEnvironment }
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = sanitize(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cache = sanitize({ ...getSettings(), ...patch })
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n')
  renameSync(tmp, file())
  return cache
}

/** The workspace folder if one is configured and still exists on disk. */
export function workspaceRoot(): string | null {
  const p = getSettings().workspacePath
  return p && existsSync(p) ? p : null
}
