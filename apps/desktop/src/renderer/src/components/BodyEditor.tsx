import { useState } from 'react'
import { removeHeader, upsertHeader } from '../headers'
import { newRow, type KeyValue } from '../request'
import {
  FORM_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  MULTIPART_BOUNDARY,
  MULTIPART_CONTENT_TYPE,
  boundaryOf,
  detectBodyMode,
  fileValue,
  parseGraphql,
  parseMultipart,
  parseUrlencoded,
  serializeGraphql,
  serializeMultipart,
  serializeUrlencoded,
  type BodyMode,
  type Field
} from '../requestBody'
import { KeyValueEditor } from './KeyValueEditor'

interface Props {
  headers: KeyValue[]
  body: string
  onChange: (patch: { body?: string; headers?: KeyValue[] }) => void
}

const MODES: { id: BodyMode; label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'urlencoded', label: 'Form (urlencoded)' },
  { id: 'multipart', label: 'Form-data' },
  { id: 'graphql', label: 'GraphQL' }
]

const area =
  'block w-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-offset-[-2px]'

function FormFields({ body, onBody }: { body: string; onBody: (b: string) => void }) {
  const [rows, setRows] = useState<KeyValue[]>(() => [
    ...parseUrlencoded(body).map((f) => ({ ...newRow(), ...f })),
    newRow()
  ])
  return (
    <KeyValueEditor
      rows={rows}
      noun="field"
      toggleable={false}
      onChange={(next) => {
        setRows(next)
        onBody(serializeUrlencoded(next))
      }}
    />
  )
}

function MultipartFields({ body, boundary, onBody }: { body: string; boundary: string; onBody: (b: string) => void }) {
  const [rows, setRows] = useState<KeyValue[]>(() => [
    ...(parseMultipart(body, boundary) ?? []).map((f) => ({ ...newRow(), ...f })),
    newRow()
  ])
  return (
    <div>
      <KeyValueEditor
        rows={rows}
        noun="field"
        toggleable={false}
        onChange={(next) => {
          setRows(next)
          onBody(serializeMultipart(next, boundary))
        }}
      />
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={async () => {
            const path = await window.deadletter.pickFile()
            if (path === null) return
            const added = [...rows.filter((r) => r.name.trim() || r.value.trim()), { ...newRow(), name: 'file', value: fileValue(path) }, newRow()]
            setRows(added)
            onBody(serializeMultipart(added, boundary))
          }}
          className="rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
        >
          Add file…
        </button>
        <p className="text-[11px] text-zinc-600">A value of <code>&lt; ./path</code> (from the workspace) or <code>&lt; /absolute/path</code> uploads that file, read when you send.</p>
      </div>
    </div>
  )
}

function Graphql({ body, onBody }: { body: string; onBody: (b: string) => void }) {
  const [gql, setGql] = useState(() => parseGraphql(body) ?? { query: '', variables: '' })
  const [error, setError] = useState<string | null>(null)

  const change = (patch: Partial<typeof gql>) => {
    const next = { ...gql, ...patch }
    setGql(next)
    const out = serializeGraphql(next)
    // While the variables are not valid JSON the file keeps its last good body.
    setError(out.ok ? null : out.error)
    if (out.ok) onBody(out.body)
  }

  return (
    <div className="grid h-full grid-rows-[minmax(0,2fr)_minmax(0,1fr)]">
      <label className="flex min-h-0 flex-col">
        <span className="px-3 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">Query</span>
        <textarea
          value={gql.query}
          onChange={(e) => change({ query: e.target.value })}
          placeholder="query { viewer { id } }"
          aria-label="GraphQL query"
          spellCheck={false}
          className={`${area} min-h-0 flex-1`}
        />
      </label>
      <label className="flex min-h-0 flex-col border-t border-zinc-900">
        <span className="px-3 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">
          Variables (JSON){error && <span role="alert" className="ml-2 normal-case text-red-400">{error}</span>}
        </span>
        <textarea
          value={gql.variables}
          onChange={(e) => change({ variables: e.target.value })}
          placeholder='{ "id": 1 }'
          aria-label="GraphQL variables"
          spellCheck={false}
          className={`${area} min-h-0 flex-1`}
        />
      </label>
    </div>
  )
}

export function BodyEditor({ headers, body, onChange }: Props) {
  const [mode, setMode] = useState<BodyMode>(() => detectBodyMode(headers, body))
  const boundary = boundaryOf(headers.find((h) => h.enabled && h.name.toLowerCase() === 'content-type')?.value ?? '') ?? MULTIPART_BOUNDARY

  const switchMode = (next: BodyMode) => {
    if (next === mode) return
    setMode(next)
    // Fields that can be carried over to a form mode; structured text (JSON, XML, multipart) is not form data.
    const carried = (): Field[] => {
      if (mode === 'multipart') return parseMultipart(body, boundary) ?? []
      if (mode === 'urlencoded') return parseUrlencoded(body)
      return /^\s*([{[<]|--)/.test(body) ? [] : parseUrlencoded(body)
    }
    if (next === 'urlencoded') {
      onChange({ body: serializeUrlencoded(carried()), headers: upsertHeader(headers, 'Content-Type', FORM_CONTENT_TYPE) })
    } else if (next === 'multipart') {
      onChange({
        body: serializeMultipart(carried(), MULTIPART_BOUNDARY),
        headers: upsertHeader(headers, 'Content-Type', MULTIPART_CONTENT_TYPE)
      })
    } else if (next === 'graphql') {
      const parsed = parseGraphql(body)
      const out = serializeGraphql(parsed ?? { query: '', variables: '' })
      onChange({ body: parsed && out.ok ? out.body : '', headers: upsertHeader(headers, 'Content-Type', JSON_CONTENT_TYPE) })
    } else if (mode === 'urlencoded' || mode === 'graphql') {
      // Back to free text: keep the text, drop a form Content-Type that no longer applies.
      const isForm = headers.some((h) => h.enabled && h.name.toLowerCase() === 'content-type' && h.value.startsWith(FORM_CONTENT_TYPE))
      onChange(isForm ? { headers: removeHeader(headers, 'Content-Type') } : {})
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div role="radiogroup" aria-label="Body type" className="flex gap-1 border-b border-zinc-900 px-2 py-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            onClick={() => switchMode(m.id)}
            className={`rounded px-2.5 py-1 text-xs ${mode === m.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === 'raw' && (
          <textarea
            value={body}
            onChange={(e) => onChange({ body: e.target.value })}
            placeholder='{"hello": "world"}'
            aria-label="Request body"
            spellCheck={false}
            className={`${area} size-full`}
          />
        )}
        {mode === 'urlencoded' && <FormFields body={body} onBody={(b) => onChange({ body: b })} />}
        {mode === 'multipart' && <MultipartFields body={body} boundary={boundary} onBody={(b) => onChange({ body: b })} />}
        {mode === 'graphql' && <Graphql body={body} onBody={(b) => onChange({ body: b })} />}
      </div>
    </div>
  )
}
