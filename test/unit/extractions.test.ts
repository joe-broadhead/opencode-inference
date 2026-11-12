// The OpenRouter Extractions adapter against sanitized fixtures: the wire request, the provider constraints enforced
// locally, the strict consumed-response schema, Unicode code-point evidence, exact usage and the exact quote.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { ExtractData, ExtractInput } from "../../src/domain/contracts.js"
import { format, money, roundUp } from "../../src/domain/money.js"
import { OPENROUTER_CAPABILITIES, type RouteCapability } from "../../src/providers/openrouter/capabilities.js"
import { EXTRACTIONS_PATH, extractionsAdapter, WIRE_REVISION } from "../../src/providers/openrouter/extractions.js"
import { snapshot, type FileAccess, type Snapshot } from "../../src/runtime/sources.js"

const STATE = "\u{1F4B6} Zoé 総額 EUR 120.00\r\nDue: none. Items: pens, ink"
const FIXTURE = readFileSync(new URL("../fixtures/providers/openrouter-extractions/clairic-text.json", import.meta.url), "utf8")
const CLAIRIC = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "cloudflare/clairic")!
const SCALEDOWN = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "scaledown/extract")!
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
const noFiles = {} as FileAccess
const textSource = (text = STATE) => snapshot({ kind: "text", text }, noFiles, CLAIRIC, new AbortController().signal)
const imageSource = (bytes: number, mime = "image/png"): Snapshot => {
  const content = new Uint8Array(bytes)
  return { origin: "path", modality: "image", mimeType: mime, bytes, sha256: sha(content), content: () => content.slice(), text: () => { throw new Error("not text") } }
}
const FIELDS = {
  name: { type: "text" },
  currency: { type: "text", nullThreshold: 0.5 },
  total: { type: "number", decimals: 2, required: true },
  due_on: { type: "date" },
  items: { type: "list", items: "text", maxItems: 5 },
} as const
const input = (fields: Record<string, unknown> = FIELDS) => ExtractInput.parse({ model: "cloudflare/clairic", source: { kind: "text", text: STATE }, fields })
const answer = (body: string, contentType = "application/json") => ({ status: 200, contentType, body: new TextEncoder().encode(body), elapsedMs: 5 })
const parse = async (body: string, fields: Record<string, unknown> = FIELDS, route: RouteCapability = CLAIRIC, source?: Snapshot) =>
  extractionsAdapter.parse(answer(body), { source: source ?? (await textSource()), route, input: input(fields) })
const withAnswers = (answers: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ model: "cloudflare/clairic", answers, ...extra })
const contractFailure = async (work: Promise<unknown>) => {
  const error = await work.then(() => undefined, (caught: Error) => caught)
  expect(error?.message).toMatch(/^PROVIDER_CONTRACT_CHANGED: /)
}

describe("the request", () => {
  test("is the documented wire shape: model, state, snake_case fields, no fallbacks, and no plugin-only option", async () => {
    const built = extractionsAdapter.request(input(), await textSource(), CLAIRIC)
    expect(built.path).toBe(EXTRACTIONS_PATH)
    expect(JSON.parse(new TextDecoder().decode(built.body))).toEqual({
      model: "cloudflare/clairic",
      state: STATE,
      fields: {
        name: { type: "text" },
        currency: { type: "text", null_threshold: 0.5 },
        total: { type: "number", decimals: 2 },
        due_on: { type: "date" },
        items: { type: "list", items: { type: "text" }, max_items: 5 },
      },
      provider: { allow_fallbacks: false },
    })
    expect(extractionsAdapter.revision).toBe(WIRE_REVISION)
  })

  test("an image is one ordered asset, base64, with its media type", () => {
    const image = imageSource(16)
    const body = JSON.parse(new TextDecoder().decode(extractionsAdapter.request(input({ name: { type: "text" } }), image, CLAIRIC).body))
    expect(body.state).toBeUndefined()
    expect(body.assets).toEqual([{ type: "image", media_type: "image/png", data: Buffer.from(new Uint8Array(16)).toString("base64") }])
  })

  test("provider constraints are refused locally with coded errors", async () => {
    const refuse = (work: () => unknown, code: string) => expect(work).toThrow(new RegExp(`^${code}: `))
    const text = await textSource()
    refuse(() => extractionsAdapter.request(input({ names: { type: "list", items: "text", nullThreshold: 0.3 } }), text, CLAIRIC), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text", nullThreshold: 0.3 } }), text, SCALEDOWN), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), imageSource(4 * 1024 * 1024 + 1), CLAIRIC), "SOURCE_LIMIT")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), imageSource(16), { ...CLAIRIC, inputs: { ...CLAIRIC.inputs, images: { ...CLAIRIC.inputs.images!, maxBytesEach: null, maxBytesTotal: 8 } } }), "SOURCE_LIMIT")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), imageSource(16, "image/gif"), CLAIRIC), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), { ...imageSource(16), modality: "pdf", mimeType: "application/pdf" }, CLAIRIC), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), text, { ...CLAIRIC, maxRequestBytes: 100 }), "CONTEXT_LIMIT")
  })
})

describe("the answer", () => {
  test("keeps nullable typed values, exact numbers, separate guesses, absent confidence and code-point evidence", async () => {
    const result = await parse(FIXTURE)
    expect(ExtractData.safeParse(result.data).success).toBe(true)
    const fields = (result.data as { fields: Record<string, any> }).fields
    const text = await textSource()
    // Code points, not UTF-16 units: the emoji before "EUR" is one code point but two units.
    expect(STATE.indexOf("EUR")).toBe(11)
    expect(fields.currency.evidence).toEqual([{ sourceHash: text.sha256, basis: "exact-text", textRange: { start: 10, end: 13, unit: "unicode-code-point", textHash: sha("EUR") } }])
    // A combining mark is its own code point: "Zoe" + U+0301 spans 2..6.
    expect(fields.name).toMatchObject({ value: "Zoé", derivation: "extracted", confidence: 0.91, evidence: [{ textRange: { start: 2, end: 6, textHash: sha("Zoé") } }] })
    expect(fields.total).toMatchObject({ value: 120, exact: "120.00", evidence: [{ textRange: { start: 14, end: 20, textHash: sha("120.00") } }] })
    // An absent value stays null; the guess is kept apart and never becomes the value; no confidence is not zero.
    expect(fields.due_on).toMatchObject({ value: null, derivation: "unknown", guess: "2026-12-01", nullProbability: 0.93, evidence: [] })
    expect(fields.due_on.confidence).toBeUndefined()
    expect(fields.due_on.review).toEqual(["CONFIDENCE_MISSING", "FIELD_ABSENT"])
    // A list item without a span keeps an empty list.
    expect(fields.items.items).toEqual([{ value: "pens", evidence: [expect.objectContaining({ textRange: expect.objectContaining({ start: 40, end: 44 }) })] }, { value: "ink", evidence: [] }])
    expect(fields.items.review).toContain("EVIDENCE_UNAVAILABLE")
    expect(result.coverage).toEqual({ status: "complete", basis: "provided-text", sourceTruncated: false, providerTruncated: false, warnings: ["1 unknown response key(s) ignored"] })
    expect(result.review).toEqual({ required: true, reasons: ["CALIBRATION_UNAVAILABLE", "CONFIDENCE_MISSING", "EVIDENCE_UNAVAILABLE", "FIELD_ABSENT"], profileVersion: "review-first-v1" })
    expect(result.providerRequestId).toBe("gen-extract-fixture-0001")
  })

  test("usage: the cost read exactly from its literal and rounded UP to 12 places; the upstream breakdown is not added", async () => {
    const result = await parse(FIXTURE)
    // 0.000012345678901234 rounds up, never down, to 0.000012345679.
    expect(result.usage).toEqual({ charges: [{ party: "platform", currency: "USD", amount: "0.000012345679", basis: "reported" }], inputTokens: 61, outputTokens: 40, costStatus: "known" })
    const byok = await parse(withAnswers(JSON.parse(FIXTURE).answers, { usage: { cost: 0.0001, is_byok: true, cost_details: { upstream_inference_cost: 0.0025 } } }))
    expect(byok.usage.charges).toEqual([
      { party: "platform", currency: "USD", amount: "0.0001", basis: "reported" },
      { party: "upstream", currency: "USD", amount: "0.0025", basis: "reported" },
    ])
    expect((await parse(withAnswers(JSON.parse(FIXTURE).answers, { usage: { cost: 0.0001, is_byok: true } }))).usage.costStatus).toBe("unknown")
    expect((await parse(withAnswers(JSON.parse(FIXTURE).answers))).usage).toEqual({ charges: [], costStatus: "unknown" })
    for (const cost of ['"0.1"', "-0.1", "1e400"]) await contractFailure(parse(FIXTURE.replace("0.000012345678901234", cost)))
  })

  test("deterministic checks mark review, never repair: integer, decimals, calendar dates, list size, evidence that disagrees", async () => {
    const result = await parse(
      withAnswers({
        count: { value: 1.5, confidence: 0.9, evidence: [{ start: 14, end: 20 }] },
        total: { value: 120.125, confidence: 0.9, evidence: [{ start: 14, end: 20 }] },
        on: { value: "2026-02-30", confidence: 0.9, evidence: [{ start: 14, end: 20 }] },
        tags: { value: ["a", "b", "c"], confidence: 0.9 },
        name: { value: "Bob", confidence: 0.9, evidence: [{ start: 2, end: 6 }] },
        quoted: { value: "EUR", confidence: 0.9, evidence: [{ start: 10, end: 13, text: "USD" }] },
      }),
      { count: { type: "number", integer: true }, total: { type: "number", decimals: 2 }, on: { type: "date" }, tags: { type: "list", items: "text", maxItems: 2 }, name: { type: "text" }, quoted: { type: "text" } },
    )
    const fields = (result.data as { fields: Record<string, any> }).fields
    for (const key of ["count", "total", "on", "tags"]) expect(fields[key].review).toContain("VALIDATION_FAILED")
    expect(fields.count.value).toBe(1.5)
    expect(fields.name.review).toContain("EVIDENCE_MISMATCH")
    // A span whose quote is not the source text is dropped, not trusted.
    expect(fields.quoted.evidence).toEqual([])
    expect(fields.quoted.review).toContain("EVIDENCE_MISMATCH")
  })

  test("truncation is partial coverage and a review reason", async () => {
    const result = await parse(withAnswers({ name: { value: "Zoé", confidence: 0.9, evidence: [{ start: 2, end: 6 }], truncated: true } }), { name: { type: "text" } })
    expect(result.coverage).toMatchObject({ status: "partial", providerTruncated: true })
    expect(result.review.reasons).toContain("PROVIDER_TRUNCATED")
  })

  test("a changed required field or type is PROVIDER_CONTRACT_CHANGED, never coerced", async () => {
    const answers = JSON.parse(FIXTURE).answers
    const bad: [string, string][] = [
      ["missing answer", withAnswers({ ...answers, total: undefined })],
      ["extra answer", withAnswers({ ...answers, extra: { value: "x" } })],
      ["number as text", withAnswers({ ...answers, total: { value: "120.00" } })],
      ["text as number", withAnswers({ ...answers, name: { value: 3 } })],
      ["no value key", withAnswers({ ...answers, name: { confidence: 0.5 } })],
      ["confidence over 1", withAnswers({ ...answers, name: { value: "x", confidence: 1.5 } })],
      ["span past the text", withAnswers({ ...answers, name: { value: "x", evidence: [{ start: 40, end: 50 }] } })],
      ["span backwards", withAnswers({ ...answers, name: { value: "x", evidence: [{ start: 5, end: 2 }] } })],
      ["span with an asset on text", withAnswers({ ...answers, name: { value: "x", evidence: [{ start: 0, end: 1, asset: 0 }] } })],
      ["list of numbers", withAnswers({ ...answers, items: { value: [1, 2] } })],
      ["items that disagree", withAnswers({ ...answers, items: { value: ["a"], items: [{ value: "b" }] } })],
      ["another model", JSON.stringify({ model: "cloudflare/other", answers })],
      ["no answers", JSON.stringify({ model: "cloudflare/clairic", fields: answers })],
      ["bad id", JSON.stringify({ model: "cloudflare/clairic", id: "x".repeat(300), answers })],
      ["not JSON", "<html>oops</html>"],
      ["duplicate key", FIXTURE.replace('"object": "extraction",', '"object": "extraction", "model": "cloudflare/clairic",')],
      ["too many unknown keys", JSON.stringify({ model: "cloudflare/clairic", answers, ...Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 1])) })],
    ]
    for (const [name, body] of bad) {
      const error = await parse(body).then(() => undefined, (caught: Error) => caught)
      expect({ name, message: error?.message.slice(0, 26) }).toEqual({ name, message: "PROVIDER_CONTRACT_CHANGED:" })
    }
    const source = await textSource()
    await contractFailure(Promise.resolve().then(() => extractionsAdapter.parse(answer(FIXTURE, "text/html"), { source, route: CLAIRIC, input: input() })))
  })

  test("image answers: evidence is attributed to the one asset sent, or refused", async () => {
    const image = imageSource(16)
    const fields = { name: { type: "text" } }
    const ok = await parse(withAnswers({ name: { value: "x", confidence: 0.9, evidence: [{ asset: 0 }] } }), fields, CLAIRIC, image)
    expect((ok.data as any).fields.name.evidence).toEqual([{ sourceHash: image.sha256, basis: "unavailable" }])
    expect(ok.coverage).toMatchObject({ status: "unknown", basis: "native-file" })
    await contractFailure(parse(withAnswers({ name: { value: "x", evidence: [{ asset: 1 }] } }), fields, CLAIRIC, image))
  })
})

describe("the quote", () => {
  const priced = (pricing: RouteCapability["pricing"]) => ({ ...CLAIRIC, pricing })
  test("no price is unavailable; a per-request ceiling is an exact upper bound", async () => {
    const text = await textSource()
    expect(extractionsAdapter.quote(CLAIRIC, text, input())).toEqual({ kind: "unavailable" })
    expect(extractionsAdapter.quote(priced({ revision: "t", currency: "USD", perRequest: "0.002", upperBound: true }), text, input())).toEqual({ kind: "upper_bound", amount: "0.002" })
    expect(extractionsAdapter.quote(priced({ revision: "t", currency: "USD", perRequest: "0.002", upperBound: false }), text, input())).toEqual({ kind: "estimate", amount: "0.002" })
  })

  test("a per-token price is an estimate, computed exactly and rounded up, never an upper bound by itself", async () => {
    const text = await textSource()
    // upperBound: true does not make a token price a ceiling: a server-side prompt template can add tokens.
    const route = priced({ revision: "t", currency: "USD", perRequest: "0.001", perMillionInputTokens: "0.333333333333", upperBound: true })
    const bytes = BigInt(extractionsAdapter.request(input(), text, route).body.byteLength)
    // 0.333333333333 USD per million tokens, times the bytes, in 10^-18 USD, rounded UP to 10^-12.
    const exact = money("0.333333333333").units * bytes
    const expected = money("0.001").units + (exact + 999_999n) / 1_000_000n
    const quoted = extractionsAdapter.quote(route, text, input())
    expect(quoted).toEqual({ kind: "estimate", amount: format({ currency: "USD", units: expected }) })
    expect(money(quoted.amount!).units * 1_000_000n).toBeGreaterThanOrEqual(money("0.001").units * 1_000_000n + exact)
    expect(roundUp("0.0000000000001").units).toBe(1n)
    expect(extractionsAdapter.quote({ ...route, pricing: { ...route.pricing!, perMillionOutputTokens: "1" } }, text, input()).kind).toBe("estimate")
    expect(extractionsAdapter.quote(route, imageSource(16), input({ name: { type: "text" } })).kind).toBe("estimate")
  })

  test("only a provider-documented ceiling, with its source, makes a per-token price an upper bound", async () => {
    const text = await textSource()
    const route = priced({ revision: "t", currency: "USD", perMillionInputTokens: "0.5", upperBound: false, ceiling: { amount: "0.03", source: "A4" } })
    expect(extractionsAdapter.quote(route, text, input())).toEqual({ kind: "upper_bound", amount: "0.03" })
  })
})

describe("through the dispatcher, with the fake transport", () => {
  test("a text extraction settles the exact reported charge against an exact upper-bound reservation, on both surfaces", async () => {
    const { probeHarness, probeRoute } = await import("../support/operation-kit.js")
    const { ExtractResult } = await import("../../src/domain/contracts.js")
    const route = probeRoute({ ...CLAIRIC, enabled: true, pricing: { revision: "test", currency: "USD", perRequest: "0.004", upperBound: true } })
    const tool = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
    const harness = await probeHarness({ route, tool, adapter: extractionsAdapter, options: { profiles: { probe: { model: "cloudflare/clairic" } } } })
    // The fixture's own bytes, so the cost literal reaches the adapter exactly as written.
    harness.replies.push(answer(FIXTURE), answer(FIXTURE))
    const request = { profile: "probe", source: { kind: "text", text: STATE }, fields: FIELDS }
    const model = (await harness.model(request)) as { output: any }
    const script = (await harness.rpc(request)) as any
    expect(ExtractResult.safeParse(model.output).success).toBe(true)
    const { operationId: _a, trace: _b, ...modelRest } = model.output
    const { operationId: _c, trace: _d, ...scriptRest } = script
    expect(scriptRest).toEqual(modelRest)
    expect(model.output.data.fields.total).toMatchObject({ value: 120, exact: "120.00" })
    const records = await harness.journal.list()
    expect(records.map((record) => [record.reservation.amount, record.reservation.basis, record.reservation.status, record.charges[0]?.amount])).toEqual([
      ["0.004", "upper_bound", "settled", "0.000012345679"],
      ["0.004", "upper_bound", "settled", "0.000012345679"],
    ])
    expect(JSON.parse(new TextDecoder().decode(harness.sent[0]!.body)).state).toBe(STATE)
  })
})

describe("reservations for per-token prices", () => {
  test("a per-token-priced route without a documented ceiling reserves the whole per-request budget, as an estimate", async () => {
    const { probeHarness, probeRoute } = await import("../support/operation-kit.js")
    const { ExtractResult } = await import("../../src/domain/contracts.js")
    const tool = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
    const run = async (pricing: RouteCapability["pricing"]) => {
      const harness = await probeHarness({ route: probeRoute({ ...CLAIRIC, enabled: true, pricing }), tool, adapter: extractionsAdapter, options: { profiles: { probe: { model: "cloudflare/clairic" } } } })
      harness.replies.push(answer(FIXTURE))
      await harness.model({ profile: "probe", source: { kind: "text", text: STATE }, fields: FIELDS })
      return (await harness.journal.list())[0]!.reservation
    }
    expect(await run({ revision: "t", currency: "USD", perRequest: "0.001", perMillionInputTokens: "0.2", upperBound: true })).toMatchObject({ amount: "0.05", basis: "admission_budget" })
    expect(await run({ revision: "t", currency: "USD", perMillionInputTokens: "0.2", upperBound: false, ceiling: { amount: "0.02", source: "A4" } })).toMatchObject({ amount: "0.02", basis: "upper_bound" })
  })
})
