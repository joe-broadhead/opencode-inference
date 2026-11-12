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
      slugChanged: [],
      drift: true,
      enables: false,
    })
    // The fixture is untouched: nothing was added, and drift enabled nothing.
    expect(OPENROUTER_CAPABILITIES.routes.some((route) => route.model === "acme/new-extractor")).toBe(false)
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
      slugChanged: [],
      drift: true,
      enables: false,
    })
  })

  test("the live catalogs carry the reviewed canonical slugs; a moved slug under the same id is drift", () => {
    expect(catalogDrift(OPENROUTER_CAPABILITIES, "extract", catalogModels(live("extractions"))).slugChanged).toEqual([])
    expect(catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels(live("decisions"))).slugChanged).toEqual([])
    const moved = catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels({ data: [{ id: "typesafe/jev-1.14", canonical_slug: "typesafe/jev-1.14-20261201" }] }))
    expect(moved).toMatchObject({ reviewed: ["typesafe/jev-1.14"], missing: [], slugChanged: [{ model: "typesafe/jev-1.14", reviewed: "typesafe/jev-1.14-20261014", listed: "typesafe/jev-1.14-20261201" }], drift: true })
    // An entry that states no slug (or an invalid one) says nothing about the model behind the id.
    for (const entry of [{ id: "typesafe/jev-1.14" }, { id: "typesafe/jev-1.14", canonical_slug: "NOT A SLUG" }])
      expect(catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels({ data: [entry] }))).toMatchObject({ slugChanged: [], drift: false })
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
    // Every route without a passed canary is disabled.
    expect(OPENROUTER_CAPABILITIES.routes.filter((route) => route.canary.status !== "passed" && route.enabled)).toEqual([])
    const enable = (canary: { status: "not_run" | "passed" | "failed"; on: string | null; reports?: string[]; wireRevision?: string }) =>
      CapabilityFixture.safeParse({ ...OPENROUTER_CAPABILITIES, routes: OPENROUTER_CAPABILITIES.routes.map((route) => (route.model === "levanto/sage-2" ? { ...route, enabled: true, canary } : route)) }).success
    const evidence = { reports: ["extractions-20261112T215014Z.json", "extractions-20261112T225713Z.json"], wireRevision: "openrouter-alpha-extractions-2026-11-12.2" }
    expect(enable({ status: "not_run", on: null, ...evidence })).toBe(false)
    expect(enable({ status: "failed", on: "2026-11-12", ...evidence })).toBe(false)
    // A pass without its evidence is refused: both reports (request and malformed request) and the wire revision.
    expect(enable({ status: "passed", on: "2026-11-12" })).toBe(false)
    expect(enable({ status: "passed", on: "2026-11-12", reports: [evidence.reports[0]!], wireRevision: evidence.wireRevision })).toBe(false)
    expect(enable({ status: "passed", on: "2026-11-12", reports: evidence.reports })).toBe(false)
    expect(enable({ status: "passed", on: "2026-11-12", reports: ["notes.txt", "x.json"], wireRevision: evidence.wireRevision })).toBe(false)
    expect(enable({ status: "passed", on: "2026-11-12", ...evidence })).toBe(true)
  })
})
