import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { ArtifactRef, CONTRACT_JSON_SCHEMAS, CONTRACTS, Coverage, DecideInput, EvidenceRef, ExtractField, ExtractInput, InferenceResult, PlanInput, QuestionInput, SourceInput, Usage } from "../../src/domain/contracts.js"

const text = { kind: "text", text: "Invoice AB-72. Total EUR 120.00." } as const
const fields = { invoice_id: { type: "text" } } as const
const artifact = {
  schemaVersion: 1,
  id: "art_1",
  ownerPluginId: "utilities.local",
  projectId: "prj_1",
  kind: "pdf",
  mimeType: "application/pdf",
  bytes: 1024,
  sha256: "a".repeat(64),
  locator: { kind: "local", path: "inputs/invoice.pdf" },
  createdAt: "2026-11-11T10:00:00Z",
  origin: { kind: "imported", parentIds: [] },
  trust: "untrusted",
} as const

describe("the source and artifact contracts", () => {
  test("accept the three leaves and reject unknown keys at every level", () => {
    expect(SourceInput.safeParse(text).success).toBe(true)
    expect(SourceInput.safeParse({ kind: "path", path: "inputs/a.pdf" }).success).toBe(true)
    expect(SourceInput.safeParse({ kind: "artifact", artifact }).success).toBe(true)
    expect(SourceInput.safeParse({ ...text, extra: 1 }).success).toBe(false)
    expect(ArtifactRef.safeParse({ ...artifact, locator: { kind: "local", path: "a", url: "https://x" } }).success).toBe(false)
    expect(ArtifactRef.safeParse({ ...artifact, trust: "trusted" }).success).toBe(false)
    expect(ArtifactRef.safeParse({ ...artifact, sha256: "A".repeat(64) }).success).toBe(false)
  })

  test("a bundle holds leaves only, with unique keys, and is bounded", () => {
    const item = (key: string) => ({ key, role: "page", source: text })
    expect(SourceInput.safeParse({ kind: "bundle", items: [item("p1"), item("p2")] }).success).toBe(true)
    expect(SourceInput.safeParse({ kind: "bundle", items: [item("p1"), item("p1")] }).success).toBe(false)
    expect(SourceInput.safeParse({ kind: "bundle", items: [{ key: "x", role: "page", source: { kind: "bundle", items: [item("y")] } }] }).success).toBe(false)
    expect(SourceInput.safeParse({ kind: "bundle", items: Array.from({ length: 65 }, (_, i) => item(`p${i}`)) }).success).toBe(false)
  })
})

describe("evidence, coverage and usage", () => {
  test("text ranges count code points and must not run backwards", () => {
    const range = { start: 3, end: 7, unit: "unicode-code-point", textHash: "b".repeat(64) }
    expect(EvidenceRef.safeParse({ sourceHash: "a".repeat(64), basis: "exact-text", textRange: range }).success).toBe(true)
    expect(EvidenceRef.safeParse({ sourceHash: "a".repeat(64), basis: "exact-text", textRange: { ...range, unit: "utf16" } }).success).toBe(false)
    expect(EvidenceRef.safeParse({ sourceHash: "a".repeat(64), basis: "exact-text", textRange: { ...range, start: 9 } }).success).toBe(false)
  })

  test("money is an exact decimal string, never a float", () => {
    const charge = { party: "platform", currency: "USD", amount: "0.0125", basis: "reported" }
    expect(Usage.safeParse({ charges: [charge], costStatus: "known" }).success).toBe(true)
    expect(Usage.safeParse({ charges: [{ ...charge, amount: 0.0125 }], costStatus: "known" }).success).toBe(false)
    expect(Usage.safeParse({ charges: [{ ...charge, amount: "1e-3" }], costStatus: "known" }).success).toBe(false)
    expect(Usage.safeParse({ charges: [{ ...charge, amount: "-1" }], costStatus: "known" }).success).toBe(false)
  })

  test("coverage requires its warnings list, and the common result requires review, coverage and usage", () => {
    expect(Coverage.safeParse({ status: "complete", basis: "provided-text", sourceTruncated: false }).success).toBe(false)
    const result = InferenceResult(z.strictObject({ fields: z.record(z.string(), z.unknown()) }))
    const value = {
      schemaVersion: 1,
      operationId: "op_1",
      data: { fields: {} },
      route: { provider: "openrouter", model: "cloudflare/clairic", apiRoute: "POST /api/alpha/extractions", endpointProfile: "p", capabilityRevision: "r" },
      coverage: { status: "complete", basis: "provided-text", sourceTruncated: false, warnings: [] },
      review: { required: true, reasons: ["CALIBRATION_UNAVAILABLE"], profileVersion: "review-first-v1" },
      usage: { charges: [], costStatus: "unknown" },
      trace: { elapsedMs: 1, attempts: 1, cacheHit: false },
      trust: "untrusted",
    }
    expect(result.safeParse(value).success).toBe(true)
    const { review: _, ...withoutReview } = value
    expect(result.safeParse(withoutReview).success).toBe(false)
  })
})

describe("the request contracts", () => {
  test("extract needs exactly one of profile and model", () => {
    expect(ExtractInput.safeParse({ source: text, fields, profile: "extract-typed" }).success).toBe(true)
    expect(ExtractInput.safeParse({ source: text, fields, model: "cloudflare/clairic" }).success).toBe(true)
    expect(ExtractInput.safeParse({ source: text, fields }).success).toBe(false)
    expect(ExtractInput.safeParse({ source: text, fields, profile: "extract-typed", model: "cloudflare/clairic" }).success).toBe(false)
  })

  test("fields are named identifiers of the supported kinds; estimate, forecast and tables are refused", () => {
    expect(ExtractInput.safeParse({ source: text, profile: "p", fields: { "Invoice ID": { type: "text" } } }).success).toBe(false)
    expect(ExtractInput.safeParse({ source: text, profile: "p", fields: {} }).success).toBe(false)
    expect(ExtractInput.safeParse({ source: text, profile: "p", fields: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, { type: "text" }])) }).success).toBe(false)
    for (const type of ["estimate", "forecast", "object", "table"]) expect(ExtractField.safeParse({ type }).success).toBe(false)
    expect(ExtractField.safeParse({ type: "list", items: "number" }).success).toBe(false)
    expect(ExtractField.safeParse({ type: "number", decimals: 2, unit: "EUR", required: true }).success).toBe(true)
    // A provider option the wrapper does not define is refused, not forwarded.
    expect(ExtractField.safeParse({ type: "text", null_threshold: 0.5 }).success).toBe(false)
  })

  test("decide needs exactly one of questions and questionSet, with unique option ids", () => {
    const kind = { type: "choice", prompt: "Which kind?", options: [{ id: "invoice", description: "A request for payment" }, { id: "other", description: "Anything else" }] }
    expect(DecideInput.safeParse({ source: text, profile: "decide-text", questions: { kind } }).success).toBe(true)
    expect(DecideInput.safeParse({ source: text, profile: "decide-text", questionSet: "document-kind-v1" }).success).toBe(true)
    expect(DecideInput.safeParse({ source: text, profile: "decide-text" }).success).toBe(false)
    expect(DecideInput.safeParse({ source: text, profile: "decide-text", questionSet: "x", questions: { kind } }).success).toBe(false)
    expect(QuestionInput.safeParse({ ...kind, options: [kind.options[0], kind.options[0]] }).success).toBe(false)
    expect(QuestionInput.safeParse({ type: "score", prompt: "How severe?", levels: [{ id: "low", description: "Low" }] }).success).toBe(false)
  })

  test("plan takes a task and the input that task would get", () => {
    expect(PlanInput.safeParse({ task: "extract", input: { source: text, fields, profile: "extract-typed" } }).success).toBe(true)
    expect(PlanInput.safeParse({ task: "decide", input: { source: text, fields, profile: "extract-typed" } }).success).toBe(false)
    expect(PlanInput.safeParse({ task: "summarise", input: {} }).success).toBe(false)
  })
})

test("every public contract exports as JSON Schema, with strict objects", () => {
  expect(Object.keys(CONTRACT_JSON_SCHEMAS).sort()).toEqual(Object.keys(CONTRACTS).sort())
  for (const [name, schema] of Object.entries(CONTRACT_JSON_SCHEMAS)) {
    expect({ name, type: typeof schema }).toEqual({ name, type: "object" })
    const text = JSON.stringify(schema)
    expect({ name, loose: text.includes('"additionalProperties":true') }).toEqual({ name, loose: false })
  }
})
