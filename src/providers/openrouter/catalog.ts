import type { CapabilityFixture } from "./capabilities.js"

// Catalog drift (handoff §3.1 A3, §7.3): compare OpenRouter's model catalog for an endpoint with the reviewed fixture,
// and report the difference as a compatibility status. Pure: the catalog is passed in (the opt-in canary fetches it;
// the plugin never does), and the result never enables anything. A model new to the catalog is a candidate, disabled
// until it is reviewed and its canary passes; a reviewed model missing from the catalog is reported, not removed.

export interface CatalogModel {
  readonly id: string
}

export interface CatalogDrift {
  readonly endpoint: string
  /** In the catalog and the fixture. */
  readonly reviewed: readonly string[]
  /** In the catalog, not in the fixture: candidates only, never enabled. */
  readonly candidates: readonly string[]
  /** In the fixture, not in the catalog: possibly withdrawn or renamed. */
  readonly missing: readonly string[]
  readonly drift: boolean
  /** Always false: drift never enables a route. */
  readonly enables: false
}

const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,95}$/

/** The model ids in a /api/v1/models answer, refusing anything that is not a list of { id }. */
export function catalogModels(answer: unknown): CatalogModel[] {
  const data = typeof answer === "object" && answer !== null && "data" in answer ? (answer as { data: unknown }).data : undefined
  if (!Array.isArray(data) || data.length > 5000) throw new Error("the catalog is not a bounded { data: [...] } list")
  return data.map((entry) => {
    const id = typeof entry === "object" && entry !== null && "id" in entry ? (entry as { id: unknown }).id : undefined
    if (typeof id !== "string" || !MODEL.test(id)) throw new Error("a catalog entry has no valid model id")
    return { id }
  })
}

/** The drift between the catalog for `operation` and the fixture's routes for it. */
export function catalogDrift(fixture: CapabilityFixture, operation: "extract" | "decide", catalog: readonly CatalogModel[]): CatalogDrift {
  const listed = new Set(catalog.map((model) => model.id))
  const known = new Set(fixture.routes.filter((route) => route.operation === operation).map((route) => route.model))
  const reviewed = [...known].filter((model) => listed.has(model)).sort()
  const candidates = [...listed].filter((model) => !known.has(model)).sort()
  const missing = [...known].filter((model) => !listed.has(model)).sort()
  return {
    endpoint: operation === "extract" ? "/api/alpha/extractions" : "/api/alpha/decisions",
    reviewed,
    candidates,
    missing,
    drift: candidates.length > 0 || missing.length > 0,
    enables: false,
  }
}
