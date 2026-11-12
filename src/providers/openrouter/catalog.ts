import type { CapabilityFixture } from "./capabilities.js"

// Catalog drift (handoff §3.1 A3, §7.3): compare OpenRouter's model catalog for an endpoint with the reviewed fixture,
// and report the difference as a compatibility status. Pure: the catalog is passed in (the opt-in canary fetches it;
// the plugin never does), and the result never enables anything. A model new to the catalog is a candidate, disabled
// until it is reviewed and its canary passes; a reviewed model missing from the catalog is reported, not removed.

export interface CatalogModel {
  readonly id: string
}

/** A moving alias such as `~typesafe/jev-latest`: reported with its target, never a route and never a listed model. */
export interface CatalogAlias {
  readonly id: string
  readonly target: string
}

/** An entry that is neither a model nor a well-formed alias: reported as drift by its id's shape, never trusted. */
export interface CatalogUnexpected {
  readonly index: number
  readonly shape: string
}

export interface Catalog {
  readonly models: readonly CatalogModel[]
  readonly aliases: readonly CatalogAlias[]
  readonly unexpected: readonly CatalogUnexpected[]
}

export interface CatalogDrift {
  readonly endpoint: string
  /** In the catalog and the fixture. */
  readonly reviewed: readonly string[]
  /** In the catalog, not in the fixture: candidates only, never enabled. */
  readonly candidates: readonly string[]
  /** In the fixture, not in the catalog: possibly withdrawn or renamed. An alias pointing at it does not count. */
  readonly missing: readonly string[]
  /** Moving aliases and their targets: information, not drift, and never a route. */
  readonly aliases: readonly CatalogAlias[]
  /** Entries whose id is neither a model id nor an alias: always drift. */
  readonly unexpected: readonly CatalogUnexpected[]
  readonly drift: boolean
  /** Always false: drift never enables a route. */
  readonly enables: false
}

const MODEL_BODY = "[a-z0-9][a-z0-9._-]{0,63}\\/[a-z0-9][a-z0-9._:-]{0,95}"
const MODEL = new RegExp(`^${MODEL_BODY}$`)
const ALIAS = new RegExp(`^~${MODEL_BODY}$`)

/**
 * The shape of an id that is not a model id or an alias: its type, its length and each character's class (a lower-case
 * letter is `a`, an upper-case one `A`, a digit `9`; `/ . _ : ~ -` are kept; anything else is `?`), at most 96 of them.
 * Enough to see why it was refused, never the id itself.
 */
export function idShape(id: unknown): string {
  if (id === undefined) return "no id"
  if (typeof id !== "string") return `an id that is ${id === null ? "null" : Array.isArray(id) ? "an array" : `a ${typeof id}`}`
  const masked = Array.from(id.slice(0, 96), (c) => (/[a-z]/.test(c) ? "a" : /[A-Z]/.test(c) ? "A" : /[0-9]/.test(c) ? "9" : /[/._:~-]/.test(c) ? c : "?")).join("")
  return `a string of ${id.length}: "${masked}${id.length > 96 ? "..." : ""}"`
}

/**
 * The models, aliases and unexpected entries in a /api/v1/models answer. Only a whole answer that is not a bounded
 * `{ data: [...] }` list is refused; one odd entry is reported, so the drift report still covers the reviewed models.
 */
export function catalogModels(answer: unknown): Catalog {
  const data = typeof answer === "object" && answer !== null && "data" in answer ? (answer as { data: unknown }).data : undefined
  if (!Array.isArray(data) || data.length > 5000) throw new Error("the catalog is not a bounded { data: [...] } list")
  const models: CatalogModel[] = []
  const aliases: CatalogAlias[] = []
  const unexpected: CatalogUnexpected[] = []
  data.forEach((entry: unknown, index) => {
    const object = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined
    const id = object?.["id"]
    if (typeof id === "string" && MODEL.test(id)) return void models.push({ id })
    if (typeof id === "string" && ALIAS.test(id)) {
      const target = object?.["alias_target"]
      const slug = typeof target === "object" && target !== null ? (target as Record<string, unknown>)["slug"] : undefined
      if (typeof slug === "string" && MODEL.test(slug)) return void aliases.push({ id, target: slug })
      return void unexpected.push({ index, shape: `an alias with no valid alias_target.slug: ${idShape(id)}` })
    }
    unexpected.push({ index, shape: object === undefined ? "not an object" : idShape(id) })
  })
  return { models, aliases, unexpected }
}

/** The drift between the catalog for `operation` and the fixture's routes for it. */
export function catalogDrift(fixture: CapabilityFixture, operation: "extract" | "decide", catalog: Catalog): CatalogDrift {
  const listed = new Set(catalog.models.map((model) => model.id))
  const known = new Set(fixture.routes.filter((route) => route.operation === operation).map((route) => route.model))
  const reviewed = [...known].filter((model) => listed.has(model)).sort()
  const candidates = [...listed].filter((model) => !known.has(model)).sort()
  const missing = [...known].filter((model) => !listed.has(model)).sort()
  return {
    endpoint: operation === "extract" ? "/api/alpha/extractions" : "/api/alpha/decisions",
    reviewed,
    candidates,
    missing,
    aliases: [...catalog.aliases].sort((a, b) => a.id.localeCompare(b.id)),
    unexpected: catalog.unexpected,
    drift: candidates.length > 0 || missing.length > 0 || catalog.unexpected.length > 0,
    enables: false,
  }
}
