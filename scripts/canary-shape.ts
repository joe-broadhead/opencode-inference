// The canaries' --shape option: the STRUCTURE of a live answer and the exact reason the adapter refused it, for the
// report. Pure, no network, no key.
//
// What a shape keeps: each JSON path (`$.answers.total.value`, `$.usage`, an array's items as `[]`), its value type
// (object, array, string, integer, number, boolean, null), an object's key count, an array's or a string's length, and a
// string's value ONLY when it sits under a status-like key (status, type, object, code, ...) and is one short word.
// What it never keeps: source text, an extracted value, a number, a free-text message, or a key that is not a plain
// identifier (shown as `<key N>`). The key is never in an answer; run.sh redacts it from all output anyway.
import { InferenceError } from "../src/domain/errors.js"

export type ShapeType = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null"

export interface ShapeEntry {
  readonly path: string
  readonly type: ShapeType
  /** Keys of an object, items of an array, characters of a string; a [min, max] range where a path repeats in a list. */
  readonly length?: number | readonly [number, number]
  /** A status word, kept only under a status-like key. */
  readonly value?: string
}

export interface Shape {
  readonly status: number
  readonly contentType: string | null
  readonly bytes: number
  readonly json: boolean
  readonly entries: readonly ShapeEntry[]
  /** True when the answer was deeper or wider than the shape's bounds, so some paths are left out. */
  readonly truncated: boolean
}

/** Keys whose short one-word string values are status words, not content. */
export const STATUS_KEYS: ReadonlySet<string> = new Set(["status", "state", "type", "object", "code", "kind", "finish_reason", "error_type"])
const WORD = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/
const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const MAX_DEPTH = 12
const MAX_ENTRIES = 400

const decode = (body: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))

/** The structural shape of one answer. A body that is not UTF-8 JSON gets `json: false` and no entries. */
export function shapeOf(answer: { readonly status: number; readonly contentType?: string | null; readonly body: Uint8Array }): Shape {
  const base = { status: answer.status, contentType: answer.contentType ?? null, bytes: answer.body.byteLength }
  let document: unknown
  try {
    document = decode(answer.body)
  } catch {
    return { ...base, json: false, entries: [], truncated: false }
  }
  const found = new Map<string, { path: string; type: ShapeType; length?: [number, number]; value?: string }>()
  let truncated = false
  const add = (path: string, type: ShapeType, length?: number, value?: string) => {
    const id = `${path}\u0000${type}\u0000${value ?? ""}`
    const existing = found.get(id)
    if (existing) {
      if (length !== undefined && existing.length) existing.length = [Math.min(existing.length[0], length), Math.max(existing.length[1], length)]
      return
    }
    if (found.size >= MAX_ENTRIES) {
      truncated = true
      return
    }
    found.set(id, { path, type, ...(length !== undefined ? { length: [length, length] as [number, number] } : {}), ...(value !== undefined ? { value } : {}) })
  }
  const walk = (value: unknown, path: string, depth: number, key: string | undefined) => {
    if (depth > MAX_DEPTH) {
      truncated = true
      return
    }
    if (value === null) add(path, "null")
    else if (Array.isArray(value)) {
      add(path, "array", value.length)
      for (const item of value) walk(item, `${path}[]`, depth + 1, undefined)
    } else if (typeof value === "object") {
      const keys = Object.keys(value as object)
      add(path, "object", keys.length)
      keys.forEach((name, index) => walk((value as Record<string, unknown>)[name], `${path}.${KEY.test(name) ? name : `<key ${index}>`}`, depth + 1, name))
    } else if (typeof value === "string") add(path, "string", value.length, key !== undefined && STATUS_KEYS.has(key) && WORD.test(value) ? value : undefined)
    else if (typeof value === "number") add(path, Number.isInteger(value) ? "integer" : "number")
    else if (typeof value === "boolean") add(path, "boolean")
  }
  walk(document, "$", 0, undefined)
  const entries = [...found.values()].map(({ length, ...entry }) => ({ ...entry, ...(length ? { length: length[0] === length[1] ? length[0] : ([length[0], length[1]] as const) } : {}) }))
  return { ...base, json: true, entries, truncated }
}

export interface Failure {
  readonly code: string
  /** The adapter's exact message: built only from our field names, paths, limits and expectations, never a value. */
  readonly message: string
  /** The JSON path it names, when it names one, such as `answers.total.confidence`. */
  readonly path?: string
  /** What the reviewed contract expects there, as the adapter states it, such as `is not a probability`. */
  readonly expected?: string
  /** The type actually found at that path in the answer, or `missing`. */
  readonly received?: string
}

const PATH = /^((?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z_][A-Za-z0-9_-]*)*) ((?:is|has|names|both|disagrees|totals|does|on)\b.*)$/

const typeName = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value

/** The adapter's refusal, with the path it names and the type found there. Anything but an InferenceError is its name only. */
export function failureOf(error: unknown, body: Uint8Array | undefined): Failure {
  if (!(error instanceof InferenceError)) return { code: "error", message: error instanceof Error ? error.name : "unknown" }
  const message = error.what
  const detail = message.replace(/^.*? the reviewed contract \([^)]*\): /, "").replace(/\.$/, "")
  const match = detail === message ? null : PATH.exec(detail)
  if (!match) return { code: error.code, message }
  const path = match[1]!
  let received = "unreadable"
  try {
    let value: unknown = body === undefined ? undefined : decode(body)
    for (const segment of path.split(".")) value = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[segment] : undefined
    received = value === undefined ? "missing" : typeName(value)
  } catch {
    // The answer is not JSON: the type stays unreadable.
  }
  return { code: error.code, message, path, expected: match[2]!, received }
}
