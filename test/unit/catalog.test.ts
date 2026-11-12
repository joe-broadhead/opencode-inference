import { describe, expect, test } from "bun:test"
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
      drift: true,
      enables: false,
    })
    // The fixture is untouched: nothing was enabled or added.
    expect(OPENROUTER_CAPABILITIES.routes.some((route) => route.enabled || route.model === "acme/new-extractor")).toBe(false)
    expect(catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels({ data: [{ id: "typesafe/jev-1.14" }] })).drift).toBe(false)
  })

  test("a malformed catalog is refused", () => {
    for (const bad of [null, {}, { data: "x" }, { data: [{}] }, { data: [{ id: "NOT A MODEL" }] }]) expect(() => catalogModels(bad)).toThrow()
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
