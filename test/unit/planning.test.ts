import { describe, expect, test } from "bun:test"
import { capabilities } from "../../src/domain/capabilities.js"
import { loadConfig, type Config } from "../../src/domain/config.js"
import { PlanInput, PlanResult } from "../../src/domain/contracts.js"
import { implemented, OPERATION_INFO } from "../../src/domain/registry.js"
import { canonical, fromMicros, plan, taskDigest, toMicros } from "../../src/domain/routing.js"
import { CapabilityFixture, OPENROUTER_CAPABILITIES, type RouteCapability } from "../../src/providers/openrouter/capabilities.js"

const NOW = new Date("2026-11-12T12:00:00Z")
const text = { kind: "text", text: "Invoice AB-72. Issued 2026-11-01. Total EUR 120.00. Terms net 30 days." } as const
const fields = { invoice_id: { type: "text" }, total: { type: "number", decimals: 2 }, issued_on: { type: "date" } } as const

const run = (request: unknown, options: { config?: Config; fixture?: CapabilityFixture; implemented?: (operation: string) => boolean; now?: Date } = {}) => {
  const result = plan(PlanInput.parse(request), {
    config: options.config ?? loadConfig({}),
    fixture: options.fixture ?? OPENROUTER_CAPABILITIES,
    implemented: options.implemented ?? implemented,
    now: options.now ?? NOW,
  })
  // Every plan is a valid PlanResult.
  expect(PlanResult.safeParse(result).success).toBe(true)
  return result
}

describe("the committed capability fixture", () => {
  test("is dated, documentation-derived, unverified, and enables no route", () => {
    expect(CapabilityFixture.safeParse(OPENROUTER_CAPABILITIES).success).toBe(true)
    expect(OPENROUTER_CAPABILITIES).toMatchObject({ reviewedOn: "2026-11-11", basis: "documentation", verified: false })
    expect(OPENROUTER_CAPABILITIES.routes.filter((route) => route.enabled)).toEqual([])
    expect(OPENROUTER_CAPABILITIES.routes.map((route) => route.model).sort()).toEqual(["cloudflare/clairic", "inception/mercury-decide", "levanto/sage-2", "scaledown/extract", "typesafe/jev-1.14"])
    // No price was stated by the reviewed sources, so none is invented.
    expect(OPENROUTER_CAPABILITIES.routes.filter((route) => route.pricing !== null)).toEqual([])
  })

  test("records the provider constraints the adapters must enforce", () => {
    const route = (model: string) => OPENROUTER_CAPABILITIES.routes.find((item) => item.model === model)!
    expect(route("cloudflare/clairic").inputs).toMatchObject({ pdf: null, images: { maxCount: 4, maxBytesEach: 4 * 1024 * 1024, maxBytesTotal: 8 * 1024 * 1024, ordered: true } })
    expect(route("cloudflare/clairic").nullThreshold.unsupportedOn).toEqual(["list", "estimate", "forecast"])
    expect(route("scaledown/extract")).toMatchObject({ fieldTypes: ["text", "list"], nullThreshold: { supported: false }, inputs: { pdf: { maxCount: 1 }, textWithDocument: false } })
    expect(route("inception/mercury-decide").inputs).toMatchObject({ images: null, pdf: null })
    expect(route("levanto/sage-2").status).toBe("unconfirmed")
    expect(route("typesafe/jev-1.14")).toMatchObject({ operation: "decide", apiRoute: "POST /api/alpha/decisions", questionTypes: ["noul", "choice", "score", "box"] })
  })
})

describe("plan", () => {
  test("text extraction on the default profile: the route, every reason it cannot run, and nothing sent", () => {
    const result = run({ task: "extract", input: { source: text, profile: "extract-typed", fields } })
    expect(result.route).toMatchObject({ status: "ineligible", requested: { profile: "extract-typed" }, reasons: [] })
    expect(result.route.selected).toMatchObject({ route: { model: "cloudflare/clairic", capabilityRevision: OPENROUTER_CAPABILITIES.revision }, eligible: false, exclusions: ["ROUTE_DISABLED", "PRICE_UNKNOWN"] })
    expect(result.execution).toMatchObject({ available: false, tool: "inference_extract" })
    expect(result.execution.reasons).toEqual(["The selected route is not eligible: ROUTE_DISABLED, PRICE_UNKNOWN."])
    expect(result.quote).toMatchObject({ kind: "unavailable", basis: "none", freshness: { reviewedOn: "2026-11-11", ageDays: 1, stale: false } })
    expect(result.transmission).toEqual({ provider: "openrouter", apiRoute: "POST /api/alpha/extractions", representation: "text", credentialScope: "inference-openrouter" })
    expect(result.coverage).toMatchObject({ expected: "complete", basis: "provided-text" })
    expect(result.review).toEqual({ likely: true, reasons: ["CALIBRATION_UNAVAILABLE"], profileVersion: "review-first-v1" })
    expect(result.source).toMatchObject({ kind: "text", bytes: Buffer.byteLength(text.text), codePoints: [...text.text].length, declared: false })
  })

  test("lists other routes as alternatives with their own reasons, and never picks one", () => {
    const result = run({ task: "extract", input: { source: text, profile: "extract-typed", fields } })
    const scaledown = result.route.alternatives.find((item) => item.route.model === "scaledown/extract")!
    expect(scaledown.exclusions).toContain("FIELD_TYPE_UNSUPPORTED")
    expect(result.route.alternatives.find((item) => item.route.model === "levanto/sage-2")!.exclusions).toContain("ROUTE_UNCONFIRMED")
    expect(result.route.alternatives.map((item) => item.route.model)).not.toContain("typesafe/jev-1.14")
  })

  test("counts code points, not UTF-16 units, for supplied text with emoji and CJK", () => {
    const value = "総額 💶 120.00 — é"
    const result = run({ task: "extract", input: { source: { kind: "text", text: value }, profile: "extract-typed", fields } })
    expect(result.source.codePoints).toBe([...value].length)
    expect(result.source.codePoints).not.toBe(value.length)
    expect(result.source.bytes).toBe(Buffer.byteLength(value, "utf8"))
  })

  test("a local path is never opened: size and hash stay unknown, and preparation names the authorized snapshot", () => {
    const result = run({ task: "extract", input: { source: { kind: "path", path: "does/not/exist/invoice.pdf" }, profile: "extract-typed", fields } })
    expect(result.source).toMatchObject({ kind: "path", representation: "local-file", declared: false, mimeType: "application/pdf" })
    expect(result.source.bytes).toBeUndefined()
    expect(result.source.sha256).toBeUndefined()
    expect(result.source.unknowns).toEqual(["bytes", "sha256", "mimeType (only guessed from the file name)"])
    expect(result.preparation.map((step) => step.step)).toEqual(["authorize-and-snapshot", "pdf-text or pdf-render"])
    expect(result.route.selected!.exclusions).toContain("MODALITY_UNSUPPORTED")
    expect(result.coverage.expected).toBe("unknown")
  })

  test("a PDF suits ScaleDown's document route, but only for text fields", () => {
    const pdf = { kind: "path", path: "inputs/invoice.pdf" } as const
    const textOnly = run({ task: "extract", input: { source: pdf, profile: "extract-pdf", fields: { invoice_id: { type: "text" }, refs: { type: "list", items: "text" } } } })
    expect(textOnly.route.selected!.exclusions).toEqual(["ROUTE_DISABLED", "PRICE_UNKNOWN"])
    expect(textOnly.preparation.map((step) => step.step)).toEqual(["authorize-and-snapshot"])
    const numbers = run({ task: "extract", input: { source: pdf, profile: "extract-pdf", fields } })
    expect(numbers.route.selected!.exclusions).toContain("FIELD_TYPE_UNSUPPORTED")
  })

  test("an artifact's size and hash are reported as declared, to be verified at execution", () => {
    const artifact = { schemaVersion: 1, id: "a", ownerPluginId: "x", projectId: "p", kind: "image", mimeType: "image/gif", bytes: 10, sha256: "c".repeat(64), locator: { kind: "local", path: "a.gif" }, createdAt: "2026-11-11T00:00:00Z", origin: { kind: "captured", parentIds: [] }, trust: "untrusted" }
    const result = run({ task: "extract", input: { source: { kind: "artifact", artifact }, profile: "extract-typed", fields } })
    expect(result.source).toMatchObject({ kind: "artifact", bytes: 10, sha256: "c".repeat(64), declared: true })
    expect(result.route.selected!.exclusions).toContain("MODALITY_UNSUPPORTED") // GIF is not among Clairic's documented types
    expect(result.preparation.map((step) => step.step)).toEqual(["verify-artifact"])
  })

  test("a bundle is refused by every route", () => {
    const result = run({ task: "extract", input: { source: { kind: "bundle", items: [{ key: "p1", role: "page", source: text }] }, profile: "extract-typed", fields } })
    expect([result.route.selected!, ...result.route.alternatives].every((item) => item.exclusions.includes("BUNDLE_UNSUPPORTED"))).toBe(true)
  })

  test("an unknown profile or model is a request-level reason, not an exception", () => {
    const profile = run({ task: "extract", input: { source: text, profile: "nope", fields } })
    expect(profile.route).toMatchObject({ status: "ineligible", reasons: ["PROFILE_UNKNOWN"] })
    expect(profile.route.selected).toBeUndefined()
    expect(profile.transmission).toBeNull()
    expect(profile.quote.kind).toBe("unavailable")
    const model = run({ task: "extract", input: { source: text, model: "acme/unknown", fields } })
    expect(model.route.reasons).toEqual(["MODEL_UNKNOWN"])
  })

  test("a model for another operation is reported, not silently swapped", () => {
    const result = run({ task: "extract", input: { source: text, model: "typesafe/jev-1.14", fields } })
    expect(result.route.selected!.exclusions).toContain("OPERATION_MISMATCH")
  })

  test("decisions: box needs an image route; a question set is unknown; text noul/choice/score fit Jev", () => {
    const choice = { type: "choice", prompt: "Which?", options: [{ id: "a", description: "A" }, { id: "b", description: "B" }] }
    const ok = run({ task: "decide", input: { source: text, profile: "decide-text", questions: { kind: choice, true_claim: { type: "noul", prompt: "Is it paid?" } } } })
    expect(ok.route.selected!.exclusions).toEqual(["ROUTE_DISABLED", "NOT_IMPLEMENTED", "PRICE_UNKNOWN"])
    const box = run({ task: "decide", input: { source: text, profile: "decide-text", questions: { where: { type: "box", prompt: "Where is the total?" } } } })
    expect(box.route.selected!.exclusions).toContain("QUESTION_TYPE_UNSUPPORTED")
    const set = run({ task: "decide", input: { source: text, profile: "decide-text", questionSet: "document-kind-v1" } })
    expect(set.route.selected!.exclusions).toContain("QUESTION_SET_UNKNOWN")
  })

  test("reading has no reviewed route in this version", () => {
    const result = run({ task: "read", input: { source: text, model: "cloudflare/clairic", question: "What is the total?" } })
    expect(result.route.selected!.exclusions).toEqual(expect.arrayContaining(["OPERATION_MISMATCH", "MODULE_DISABLED", "NOT_IMPLEMENTED"]))
    expect(result.route.alternatives).toEqual([])
    expect(result.execution.tool).toBe("inference_read")
  })

  test("trusted options narrow eligibility: modules, field limit, ZDR and the price rules", () => {
    const strict = loadConfig({ modules: { extractions: false }, limits: { maxFields: 2 }, data: { requireZdr: true } })
    const result = run({ task: "extract", input: { source: text, profile: "extract-typed", fields } }, { config: strict })
    expect(result.route.selected!.exclusions).toEqual(expect.arrayContaining(["MODULE_DISABLED", "FIELD_LIMIT", "ZDR_UNKNOWN"]))
    const loose = loadConfig({ spend: { requirePricedRoute: false } })
    expect(run({ task: "extract", input: { source: text, profile: "extract-typed", fields } }, { config: loose }).route.selected!.exclusions).not.toContain("PRICE_UNKNOWN")
    const bound = loadConfig({ spend: { requirePricedRoute: false, requireUpperBound: true } })
    expect(run({ task: "extract", input: { source: text, profile: "extract-typed", fields } }, { config: bound }).route.selected!.exclusions).toContain("PRICE_UNKNOWN")
  })

  test("a tool input can only lower the deadline", () => {
    expect(run({ task: "extract", input: { source: text, profile: "extract-typed", fields, limits: { deadlineMs: 5000 } } }).limits.deadlineMs).toBe(5000)
    expect(run({ task: "extract", input: { source: text, profile: "extract-typed", fields, limits: { deadlineMs: 600_000 } } }).limits.deadlineMs).toBe(60_000)
  })

  test("the digest covers the task, not the source content, and is stable under key order", () => {
    const a = PlanInput.parse({ task: "extract", input: { source: text, profile: "extract-typed", fields } })
    const b = PlanInput.parse({ task: "extract", input: { fields: { issued_on: { type: "date" }, total: { decimals: 2, type: "number" }, invoice_id: { type: "text" } }, profile: "extract-typed", source: { kind: "text", text: "different content" } } })
    expect(taskDigest(a)).toBe(taskDigest(b))
    const c = PlanInput.parse({ task: "extract", input: { source: text, profile: "extract-typed", fields: { invoice_id: { type: "text" } } } })
    expect(taskDigest(c)).not.toBe(taskDigest(a))
    expect(canonical({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}')
  })

  test("a stale fixture is reported in the quote's freshness", () => {
    const result = run({ task: "extract", input: { source: text, profile: "extract-typed", fields } }, { now: new Date("2027-01-15T00:00:00Z") })
    expect(result.quote.freshness).toEqual({ reviewedOn: "2026-11-11", ageDays: 65, stale: true })
  })
})

describe("quotes from a priced fixture (synthetic; the committed fixture has no prices)", () => {
  const priced = (pricing: RouteCapability["pricing"]): CapabilityFixture => ({
    ...OPENROUTER_CAPABILITIES,
    routes: OPENROUTER_CAPABILITIES.routes.map((route) => (route.model === "cloudflare/clairic" ? { ...route, enabled: true, pricing } : route)),
  })
  const request = { task: "extract", input: { source: text, profile: "extract-typed", fields } }

  test("a per-request price that is a ceiling is an upper bound; otherwise an estimate", () => {
    expect(run(request, { fixture: priced({ revision: "t1", currency: "USD", perRequest: "0.002", upperBound: true }) }).quote).toMatchObject({ kind: "upper_bound", amount: "0.002", currency: "USD", basis: "fixture", priceRevision: "t1" })
    expect(run(request, { fixture: priced({ revision: "t1", currency: "USD", perRequest: "0.002", upperBound: false }) }).quote).toMatchObject({ kind: "estimate", amount: "0.002" })
  })

  test("a token price gives an estimate range with output tokens and passes as unknowns, in exact decimals", () => {
    const quote = run(request, { fixture: priced({ revision: "t2", currency: "USD", perMillionInputTokens: "1.50", upperBound: false }) }).quote
    expect(quote.kind).toBe("estimate")
    expect(quote.range).toEqual({ min: "0.000018", max: "0.000053" })
    expect(quote.unknowns).toEqual(["output tokens", "provider passes"])
  })

  test("with an enabled, priced route and an implemented tool, the plan is eligible and executable", () => {
    const result = run(request, { fixture: priced({ revision: "t1", currency: "USD", perRequest: "0.002", upperBound: true }), implemented: () => true })
    expect(result.route.status).toBe("eligible")
    expect(result.execution).toEqual({ available: true, tool: "inference_extract", reasons: [] })
  })

  test("decimal arithmetic round-trips without floats", () => {
    expect(toMicros("0.05")).toBe(50_000n)
    expect(toMicros("12.3456789")).toBe(12_345_678n)
    expect(fromMicros(1_050_000n)).toBe("1.05")
    expect(fromMicros(0n)).toBe("0")
  })
})

describe("capabilities", () => {
  const context = (config = loadConfig({})) => ({ config, fixture: OPENROUTER_CAPABILITIES, operations: OPERATION_INFO, implemented, now: NOW })

  test("names extract as implemented and decide and read as not, and every route with why it cannot run", () => {
    const result = capabilities({}, context())
    expect(result.operations.map((operation) => [operation.tool, operation.class, operation.implemented])).toEqual([
      ["inference_extract", "send", true],
      ["inference_decide", "send", false],
      ["inference_read", "send", false],
    ])
    expect(result.routes.every((route) => !route.available && route.reasons.includes("ROUTE_DISABLED"))).toBe(true)
    expect(result.routes.filter((route) => route.reasons.includes("NOT_IMPLEMENTED")).map((route) => route.operation)).toEqual(["decide"])
    expect(result.routes.find((route) => route.model === "cloudflare/clairic")!.profiles).toEqual(["extract-typed"])
    expect(result.fixture).toMatchObject({ revision: OPENROUTER_CAPABILITIES.revision, verified: false, ageDays: 1, stale: false })
    expect(result.routing).toEqual({ mode: "explicit", fallbacks: [] })
  })

  test("filters by operation and model, and reports profiles naming unknown models", () => {
    expect(capabilities({ operation: "decide" }, context()).routes.map((route) => route.model)).toEqual(["typesafe/jev-1.14"])
    expect(capabilities({ model: "scaledown/extract" }, context()).routes.map((route) => route.model)).toEqual(["scaledown/extract"])
    const custom = capabilities({}, context(loadConfig({ profiles: { mine: { model: "acme/other" } } })))
    expect(custom.profiles).toEqual([{ name: "mine", model: "acme/other", operation: null }])
  })
})

describe("null thresholds are refused locally where a route does not take them", () => {
  const extract = (model: string, fieldsIn: Record<string, unknown>) => run({ task: "extract", input: { model, source: text, fields: fieldsIn } })
  const excluded = (result: ReturnType<typeof run>) => result.route.selected!.exclusions.includes("NULL_THRESHOLD_UNSUPPORTED")
  test("Clairic: on a text, number or date field yes; on a list no", () => {
    expect(excluded(extract("cloudflare/clairic", { name: { type: "text", nullThreshold: 0.5 }, total: { type: "number", nullThreshold: 0.2 }, on: { type: "date", nullThreshold: 0.9 } }))).toBe(false)
    expect(excluded(extract("cloudflare/clairic", { names: { type: "list", items: "text", nullThreshold: 0.5 } }))).toBe(true)
  })
  test("ScaleDown: never; a route whose support is unknown: never", () => {
    expect(excluded(extract("scaledown/extract", { name: { type: "text", nullThreshold: 0.5 } }))).toBe(true)
    expect(excluded(extract("inception/mercury-decide", { name: { type: "text", nullThreshold: 0.5 } }))).toBe(true)
    expect(excluded(extract("scaledown/extract", { name: { type: "text" } }))).toBe(false)
  })
  test("a threshold must be a probability", () => {
    expect(() => PlanInput.parse({ task: "extract", input: { model: "cloudflare/clairic", source: text, fields: { name: { type: "text", nullThreshold: 1.5 } } } })).toThrow()
  })
})

describe("plan quotes for per-token prices", () => {
  test("an estimate unless the fixture records a documented ceiling", () => {
    const priced = (pricing: RouteCapability["pricing"]) => ({ ...OPENROUTER_CAPABILITIES, routes: OPENROUTER_CAPABILITIES.routes.map((route) => (route.model === "cloudflare/clairic" ? { ...route, pricing } : route)) })
    const quote = (pricing: RouteCapability["pricing"]) => run({ task: "extract", input: { source: text, profile: "extract-typed", fields } }, { fixture: priced(pricing) }).quote
    expect(quote({ revision: "t", currency: "USD", perMillionInputTokens: "0.2", upperBound: true }).kind).toBe("estimate")
    expect(quote({ revision: "t", currency: "USD", perMillionInputTokens: "0.2", upperBound: false, ceiling: { amount: "0.02", source: "A4" } })).toMatchObject({ kind: "upper_bound", amount: "0.02" })
  })
})
