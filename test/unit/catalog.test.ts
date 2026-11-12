import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { catalogDrift, catalogModels } from "../../src/providers/openrouter/catalog.js"
import { CapabilityFixture, OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"

describe("catalog drift is a compatibility status, never an enablement", () => {
  test("new catalog models are disabled candidates; reviewed models missing from the catalog are reported", () => {
    const catalog = catalogModels({ data: [{ id: "cloudflare/clairic", name: "Clairic" }, { id: "scaledown/extract" }, { id: "acme/new-extractor" }] })
    const drift = catalogDrift(OPENROUTER_CAPABILITIES, "extract", catalog)
    expect(drift).toEqual({
      endpoint: "/api/alpha/extractions",
      reviewed: ["cloudflare/clairic", "scaledown/extract"],
      candidates: ["acme/new-extractor"],
      missing: ["inception/mercury-decide", "levanto/sage-2"],
      aliases: [],
      unexpected: [],
      drift: true,
      enables: false,
    })
    // The fixture is untouched: nothing was enabled or added.
    expect(OPENROUTER_CAPABILITIES.routes.some((route) => route.enabled || route.model === "acme/new-extractor")).toBe(false)
    expect(catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels({ data: [{ id: "typesafe/jev-1.14" }] })).drift).toBe(false)
  })

  // The live catalogs of 2026-11-12, trimmed to ids and field names (test/fixtures/openrouter/). Each entry is rebuilt
  // with every field the live entry had, so the parser sees the real shape.
  const live = (endpoint: "extractions" | "decisions") => {
    const fixture = JSON.parse(readFileSync(new URL(`../fixtures/openrouter/catalog-${endpoint}-2026-11-12.json`, import.meta.url), "utf8")) as { entryFields: string[]; total_count: number; data: { id: string; alias_target?: { slug: string } }[] }
    const filler = (entry: object) => Object.fromEntries(fixture.entryFields.filter((field) => field !== "alias_target" && !(field in entry)).map((field) => [field, null]))
    return { data: fixture.data.map((entry) => ({ ...filler(entry), ...entry })), total_count: fixture.total_count, links: { next: null } }
  }

  test("the live decisions catalog: its five ~aliases are reported with their targets, Jev is reviewed, nothing throws", () => {
    const catalog = catalogModels(live("decisions"))
    expect(catalog.models).toHaveLength(31)
    expect(catalog.unexpected).toEqual([])
    expect(catalog.aliases.map((alias) => alias.id).sort()).toEqual(["~liquid/d1-latest", "~liquid/d1-ultra-latest", "~perplexity/pplx-decider-flash-latest", "~perplexity/pplx-decider-latest", "~typesafe/jev-latest"])
    const drift = catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalog)
    expect(drift.reviewed).toEqual(["typesafe/jev-1.14"])
    expect(drift.missing).toEqual([])
    expect(drift.aliases).toContainEqual({ id: "~typesafe/jev-latest", target: "typesafe/jev-1.14" })
    // An alias is never a candidate route: candidates are the 30 other pinned models only.
    expect(drift.candidates).toHaveLength(30)
    expect(drift.candidates.some((id) => id.startsWith("~"))).toBe(false)
    expect(drift).toMatchObject({ drift: true, enables: false })
  })

  test("the live extractions catalog: Clairic and ScaleDown are listed, Mercury and Sage are missing", () => {
    expect(catalogDrift(OPENROUTER_CAPABILITIES, "extract", catalogModels(live("extractions")))).toEqual({
      endpoint: "/api/alpha/extractions",
      reviewed: ["cloudflare/clairic", "scaledown/extract"],
      candidates: [],
      missing: ["inception/mercury-decide", "levanto/sage-2"],
      aliases: [],
      unexpected: [],
      drift: true,
      enables: false,
    })
  })

  test("an alias never stands in for a reviewed model: only its exact id lists it", () => {
    const drift = catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels({ data: [{ id: "~typesafe/jev-latest", alias_target: { slug: "typesafe/jev-1.14" } }] }))
    expect(drift).toMatchObject({ reviewed: [], missing: ["typesafe/jev-1.14"], aliases: [{ id: "~typesafe/jev-latest", target: "typesafe/jev-1.14" }], drift: true })
  })

  test("a catalog that is not a bounded list is refused; an odd entry is reported as unexpected drift by its id's shape", () => {
    for (const bad of [null, {}, { data: "x" }, { data: Array.from({ length: 5001 }, () => ({ id: "a/b" })) }]) expect(() => catalogModels(bad)).toThrow()
    const catalog = catalogModels({ data: [{}, { id: "NOT A MODEL" }, { id: 7 }, "x", { id: "~acme/x-latest" }, { id: "~acme/y-latest", alias_target: { slug: "BAD SLUG" } }, { id: "typesafe/jev-1.14" }] })
    expect(catalog).toEqual({
      models: [{ id: "typesafe/jev-1.14" }],
      aliases: [],
      unexpected: [
        { index: 0, shape: "no id" },
        { index: 1, shape: 'a string of 11: "AAA?A?AAAAA"' },
        { index: 2, shape: "an id that is a number" },
        { index: 3, shape: "not an object" },
        { index: 4, shape: 'an alias with no valid alias_target.slug: a string of 14: "~aaaa/a-aaaaaa"' },
        { index: 5, shape: 'an alias with no valid alias_target.slug: a string of 14: "~aaaa/a-aaaaaa"' },
      ],
    })
    // Unexpected entries are drift, and the reviewed model is still matched strictly.
    expect(catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalog)).toMatchObject({ reviewed: ["typesafe/jev-1.14"], missing: [], drift: true, enables: false })
    // An id longer than 96 characters is shown only to 96.
    expect(catalogModels({ data: [{ id: "A".repeat(200) }] }).unexpected[0]!.shape).toBe(`a string of 200: "${"A".repeat(96)}..."`)
  })

  test("the fixture refuses an enabled route whose canary has not passed, and records the catalog as not checked", () => {
    expect(OPENROUTER_CAPABILITIES.catalog).toEqual({ checkedOn: null, status: "not_checked" })
    expect(OPENROUTER_CAPABILITIES.routes.every((route) => route.canary.status === "not_run")).toBe(true)
    const enable = (canary: { status: "not_run" | "passed" | "failed"; on: string | null }) =>
      CapabilityFixture.safeParse({ ...OPENROUTER_CAPABILITIES, routes: OPENROUTER_CAPABILITIES.routes.map((route, index) => (index === 0 ? { ...route, enabled: true, canary } : route)) }).success
    expect(enable({ status: "not_run", on: null })).toBe(false)
    expect(enable({ status: "failed", on: "2026-11-12" })).toBe(false)
    expect(enable({ status: "passed", on: "2026-11-12" })).toBe(true)
  })
})
