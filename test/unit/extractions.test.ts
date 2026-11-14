// The OpenRouter Extractions adapter against sanitized fixtures: the wire request, the provider constraints enforced
// locally, the strict consumed-response schema, Unicode code-point evidence, exact usage and the exact quote.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { ExtractData, ExtractInput } from "../../src/domain/contracts.js"
import { format, money, roundUp } from "../../src/domain/money.js"
import { CLAIRIC_DOCUMENTED_IMAGES, OPENROUTER_CAPABILITIES, type RouteCapability } from "../../src/providers/openrouter/capabilities.js"
import { EXTRACTIONS_PATH, extractionsAdapter, WIRE_REVISION } from "../../src/providers/openrouter/extractions.js"
import { snapshot, type FileAccess, type Snapshot } from "../../src/runtime/sources.js"

const STATE = "\u{1F4B6} Zoé 総額 EUR 120.00\r\nDue: none. Items: pens, ink"
const FIXTURE = readFileSync(new URL("../fixtures/providers/openrouter-extractions/clairic-text.json", import.meta.url), "utf8")
const CLAIRIC = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "cloudflare/clairic")!
/** Clairic with its documented image input, whatever the fixture enables: the adapter's image handling is tested here. */
const CLAIRIC_IMAGES: RouteCapability = { ...CLAIRIC, inputs: { ...CLAIRIC.inputs, images: CLAIRIC_DOCUMENTED_IMAGES } }
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
  test("is the documented wire shape (A4): model, state, fields with documented keys only, no fallbacks, no plugin-only option", async () => {
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
        // A list's items is a string, and maxItems is checked locally, never sent (the schema allows no other key).
        items: { type: "list", items: "text" },
      },
      provider: { allow_fallbacks: false },
    })
    expect(extractionsAdapter.revision).toBe(WIRE_REVISION)
    // A description is sent as the documented `instructions`.
    const described = JSON.parse(new TextDecoder().decode(extractionsAdapter.request(input({ total: { type: "number", description: "The invoice total" } }), await textSource(), CLAIRIC).body))
    expect(described.fields).toEqual({ total: { type: "number", instructions: "The invoice total" } })
  })

  test("a file is one documented asset (A2): a keyed map entry with type, format and data_base64, and no state", () => {
    const image = imageSource(16)
    const body = JSON.parse(new TextDecoder().decode(extractionsAdapter.request(input({ name: { type: "text" } }), image, CLAIRIC_IMAGES).body))
    expect(body.state).toBeUndefined()
    expect(body.assets).toEqual({ source: { type: "image", format: "png", data_base64: Buffer.from(new Uint8Array(16)).toString("base64") } })
    const pdf = { ...imageSource(16), modality: "pdf" as const, mimeType: "application/pdf" }
    expect(JSON.parse(new TextDecoder().decode(extractionsAdapter.request(input({ name: { type: "text" } }), pdf, SCALEDOWN).body)).assets).toEqual({ source: { type: "document", format: "pdf", data_base64: Buffer.from(new Uint8Array(16)).toString("base64") } })
  })

  test("provider constraints are refused locally with coded errors", async () => {
    const refuse = (work: () => unknown, code: string) => expect(work).toThrow(new RegExp(`^${code}: `))
    const text = await textSource()
    refuse(() => extractionsAdapter.request(input({ names: { type: "list", items: "text", nullThreshold: 0.3 } }), text, CLAIRIC), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text", nullThreshold: 0.3 } }), text, SCALEDOWN), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), imageSource(4 * 1024 * 1024 + 1), CLAIRIC_IMAGES), "SOURCE_LIMIT")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), imageSource(16), { ...CLAIRIC_IMAGES, inputs: { ...CLAIRIC_IMAGES.inputs, images: { ...CLAIRIC_DOCUMENTED_IMAGES, maxBytesEach: null, maxBytesTotal: 8 } } }), "SOURCE_LIMIT")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), imageSource(16, "image/gif"), CLAIRIC_IMAGES), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), { ...imageSource(16), modality: "pdf", mimeType: "application/pdf" }, CLAIRIC), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ name: { type: "text" } }), text, { ...CLAIRIC, maxRequestBytes: 100 }), "CONTEXT_LIMIT")
    // The schema keeps at most 6 decimals; a duration answer is a number in a unit this version's result cannot carry.
    refuse(() => extractionsAdapter.request(input({ total: { type: "number", decimals: 7 } }), text, CLAIRIC), "CAPABILITY_UNSUPPORTED")
    refuse(() => extractionsAdapter.request(input({ took: { type: "duration" } }), text, CLAIRIC), "CAPABILITY_UNSUPPORTED")
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
    expect(fields.total).toMatchObject({ guess: 120, nullProbability: 2.3e-8 })
    expect(fields.items.review).toContain("EVIDENCE_UNAVAILABLE")
    expect(result.coverage).toEqual({ status: "complete", basis: "provided-text", sourceTruncated: false, providerTruncated: false, warnings: ["1 unknown response key(s) ignored"] })
    expect(result.review).toEqual({ required: true, reasons: ["CALIBRATION_UNAVAILABLE", "CONFIDENCE_MISSING", "EVIDENCE_UNAVAILABLE", "FIELD_ABSENT"], profileVersion: "review-first-v1" })
    expect(result.providerRequestId).toBe("gen-extract-fixture-0001")
  })

  test("the live Clairic answer's structure (canary, 2026-11-12) is accepted: a synthetic answer with exactly that structure parses", async () => {
    const { shapeOf } = await import("../../scripts/canary-shape.js")
    const live = JSON.parse(readFileSync(new URL("../fixtures/providers/openrouter-extractions/clairic-live-shape.json", import.meta.url), "utf8"))
    const body = JSON.stringify(live.synthetic)
    // The synthetic answer has the recorded structure, path for path and type for type.
    const shape = shapeOf({ status: 200, contentType: "application/json", body: new TextEncoder().encode(body) })
    const comparable = (entries: { path: string; type: string; length?: unknown; value?: string }[]) => entries.map(({ path, type, value }) => ({ path, type, ...(value ? { value } : {}) }))
    expect(comparable(shape.entries as never)).toEqual(comparable(live.recorded.entries))
    for (const entry of live.recorded.entries as { path: string; length?: number }[])
      if ((entry.path === "$.model" || entry.path === "$.id" || entry.path === "$.provider") && entry.length !== undefined)
        expect({ path: entry.path, length: shape.entries.find((item) => item.path === entry.path)!.length }).toEqual({ path: entry.path, length: entry.length })
    // The canary's own request: one number field, total, with 2 decimals, on "Total EUR 1.00".
    const source = await textSource("Total EUR 1.00")
    const canaryInput = ExtractInput.parse({ model: "cloudflare/clairic", source: { kind: "text", text: "Total EUR 1.00" }, fields: { total: { type: "number", decimals: 2 } } })
    const result = extractionsAdapter.parse(answer(body), { source, route: CLAIRIC, input: canaryInput })
    const total = (result.data as { fields: Record<string, any> }).fields.total
    expect(total).toMatchObject({ type: "number", value: 1, exact: "1", guess: 1, nullProbability: 0.0001, confidence: 0.99, evidence: [] })
    // No span came back: the value is reviewed for missing evidence, never given an invented offset.
    expect(total.review).toEqual(["EVIDENCE_UNAVAILABLE"])
    expect(result.usage).toEqual({ charges: [{ party: "platform", currency: "USD", amount: "0.0000125", basis: "reported" }], inputTokens: 120, outputTokens: 0, costStatus: "known" })
    expect(result.coverage.warnings).toEqual([])
    expect(result.providerRequestId).toBe("gen-ext-1794000000-ABCDEFGHIJKLMNOPQRST")
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
        count: { type: "number", value: 1.5, confidence: 0.9, span: [14, 20] },
        total: { type: "number", value: 120.125, confidence: 0.9, span: [14, 20] },
        on: { type: "date", value: "2026-02-30", confidence: 0.9, span: [14, 20] },
        tags: { type: "list", value: ["a", "b", "c"], confidence: 0.9 },
        name: { type: "text", value: "Bob", confidence: 0.9, span: [2, 6] },
        listed: { type: "list", value: ["pens", "ink"], confidence: 0.9, spans: [[40, 44], [10, 13]] },
      }),
      { count: { type: "number", integer: true }, total: { type: "number", decimals: 2 }, on: { type: "date" }, tags: { type: "list", items: "text", maxItems: 2 }, name: { type: "text" }, listed: { type: "list", items: "text" } },
    )
    const fields = (result.data as { fields: Record<string, any> }).fields
    for (const key of ["count", "total", "on", "tags"]) expect(fields[key].review).toContain("VALIDATION_FAILED")
    expect(fields.count.value).toBe(1.5)
    // A value its span does not quote is reviewed, never moved: the span stays as reported.
    expect(fields.name.review).toContain("EVIDENCE_MISMATCH")
    expect(fields.name.evidence).toHaveLength(1)
    // A list item whose span quotes something else ("EUR" for "ink") is reviewed the same way.
    expect(fields.listed.review).toContain("EVIDENCE_MISMATCH")
    expect(fields.listed.items.map((item: { evidence: unknown[] }) => item.evidence.length)).toEqual([1, 1])
  })

  test("a number's evidence is checked against its digits, quoted or not", async () => {
    const result = await parse(
      withAnswers({ right: { type: "number", value: 120.0, confidence: 0.9, span: [14, 20] }, wrong: { type: "number", value: 120.0, confidence: 0.9, span: [10, 13] } }),
      { right: { type: "number" }, wrong: { type: "number" } },
    )
    const fields = (result.data as { fields: Record<string, any> }).fields
    expect(fields.right.review).not.toContain("EVIDENCE_MISMATCH")
    expect(fields.wrong.review).toContain("EVIDENCE_MISMATCH")
  })

  test("a long number literal is kept whole; past 1024 characters, and text past 1 MB, is a contract failure before settling", async () => {
    const long = `0.${"1".repeat(100)}`
    const kept = await parse(withAnswers({ total: { type: "number", value: "__N__", confidence: 0.9 } }).replace('"__N__"', long), { total: { type: "number" } })
    expect((kept.data as any).fields.total.exact).toBe(long)
    expect(ExtractData.safeParse(kept.data).success).toBe(true)
    await contractFailure(parse(withAnswers({ total: { type: "number", value: "__N__" } }).replace('"__N__"', `0.${"1".repeat(1100)}`), { total: { type: "number" } }))
    const huge = "x".repeat(1_000_001)
    await contractFailure(parse(withAnswers({ name: { type: "text", value: huge } }), { name: { type: "text" } }))
    await contractFailure(parse(withAnswers({ name: { type: "text", value: null, guess: huge } }), { name: { type: "text" } }))
    await contractFailure(parse(withAnswers({ tags: { type: "list", value: [huge] } }), { tags: { type: "list", items: "text" } }))
  })

  test("truncation is partial coverage and a review reason", async () => {
    const result = await parse(withAnswers({ name: { type: "text", value: "Zoé", confidence: 0.9, span: [2, 6] } }, { truncated: true }), { name: { type: "text" } })
    expect(result.coverage).toMatchObject({ status: "partial", providerTruncated: true })
    expect(result.review.reasons).toContain("PROVIDER_TRUNCATED")
  })

  test("a changed required field or type is PROVIDER_CONTRACT_CHANGED, never coerced", async () => {
    const answers = JSON.parse(FIXTURE).answers
    const bad: [string, string][] = [
      ["missing answer", withAnswers({ ...answers, total: undefined })],
      ["extra answer", withAnswers({ ...answers, extra: { type: "text", value: "x" } })],
      ["no type", withAnswers({ ...answers, name: { value: "x" } })],
      ["another type", withAnswers({ ...answers, name: { type: "number", value: 3 } })],
      ["number as text", withAnswers({ ...answers, total: { type: "number", value: "120.00" } })],
      ["text as number", withAnswers({ ...answers, name: { type: "text", value: 3 } })],
      ["no value key", withAnswers({ ...answers, name: { type: "text", confidence: 0.5 } })],
      ["confidence over 1", withAnswers({ ...answers, name: { type: "text", value: "x", confidence: 1.5 } })],
      ["p_null over 1", withAnswers({ ...answers, name: { type: "text", value: "x", p_null: 2 } })],
      ["span past the text", withAnswers({ ...answers, name: { type: "text", value: "x", span: [40, 50] } })],
      ["span backwards", withAnswers({ ...answers, name: { type: "text", value: "x", span: [5, 2] } })],
      ["span not a pair", withAnswers({ ...answers, name: { type: "text", value: "x", span: [1, 2, 3] } })],
      ["source a file on text", withAnswers({ ...answers, name: { type: "text", value: "x", source: "image" } })],
      ["spans on a text field", withAnswers({ ...answers, name: { type: "text", value: "x", spans: [[0, 1]] } })],
      ["span on a list", withAnswers({ ...answers, items: { type: "list", value: ["a"], span: [0, 1] } })],
      ["list of numbers", withAnswers({ ...answers, items: { type: "list", value: [1, 2] } })],
      ["spans that disagree", withAnswers({ ...answers, items: { type: "list", value: ["a"], spans: [[0, 1], [1, 2]] } })],
      ["confidences that disagree", withAnswers({ ...answers, items: { type: "list", value: ["a"], confidences: [0.5, 0.5] } })],
      ["provider not a name", JSON.stringify({ model: "cloudflare/clairic", provider: 7, answers })],
      ["another model", JSON.stringify({ model: "cloudflare/other", answers })],
      ["no answers", JSON.stringify({ model: "cloudflare/clairic", fields: answers })],
      ["bad id", JSON.stringify({ model: "cloudflare/clairic", id: "x".repeat(300), answers })],
      ["not JSON", "<html>oops</html>"],
      ["duplicate key", FIXTURE.replace('"provider": "Cloudflare",', '"provider": "Cloudflare", "model": "cloudflare/clairic",')],
      ["too many unknown keys", JSON.stringify({ model: "cloudflare/clairic", answers, ...Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 1])) })],
    ]
    for (const [name, body] of bad) {
      const error = await parse(body).then(() => undefined, (caught: Error) => caught)
      expect({ name, message: error?.message.slice(0, 26) }).toEqual({ name, message: "PROVIDER_CONTRACT_CHANGED:" })
    }
    const source = await textSource()
    await contractFailure(Promise.resolve().then(() => extractionsAdapter.parse(answer(FIXTURE, "text/html"), { source, route: CLAIRIC, input: input() })))
  })

  test("state_text is accepted only when it is exactly the text sent: spans would otherwise index other text", async () => {
    const answers = JSON.parse(FIXTURE).answers
    const same = await parse(withAnswers(answers, { state_text: STATE }))
    expect((same.data as any).fields.currency.evidence[0].textRange).toMatchObject({ start: 10, end: 13 })
    await contractFailure(parse(withAnswers(answers, { state_text: STATE.replace("EUR", "USD") })))
    await contractFailure(parse(withAnswers(answers, { state_text: `${STATE} ` })))
    // A file sent no text, so no state_text can be the text sent.
    await contractFailure(parse(withAnswers({ name: { type: "text", value: "x", source: "image" } }, { state_text: "x" }), { name: { type: "text" } }, CLAIRIC_IMAGES, imageSource(16)))
    // null is no state_text.
    expect((await parse(withAnswers(answers, { state_text: null }))).providerRequestId).toBeUndefined()
  })

  test("image answers: read from the image, with no text span; a span or a state source is refused", async () => {
    const image = imageSource(16)
    const fields = { name: { type: "text" } }
    const ok = await parse(withAnswers({ name: { type: "text", value: "x", confidence: 0.9, source: "image", spell_confidence: 0.8 } }), fields, CLAIRIC_IMAGES, image)
    expect((ok.data as any).fields.name).toMatchObject({ evidence: [], spellingConfidence: 0.8, review: ["EVIDENCE_UNAVAILABLE"] })
    expect(ok.coverage).toMatchObject({ status: "unknown", basis: "native-file" })
    await contractFailure(parse(withAnswers({ name: { type: "text", value: "x", span: [0, 1] } }), fields, CLAIRIC_IMAGES, image))
    await contractFailure(parse(withAnswers({ name: { type: "text", value: "x", source: "state" } }), fields, CLAIRIC_IMAGES, image))
  })
})

describe("the quote", () => {
  const priced = (pricing: RouteCapability["pricing"]) => ({ ...CLAIRIC_IMAGES, pricing })
  test("no price is unavailable; a per-request ceiling is an exact upper bound", async () => {
    const text = await textSource()
    expect(extractionsAdapter.quote(priced(null), text, input())).toEqual({ kind: "unavailable" })
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

describe("duration is not adopted", () => {
  test("plan reports a duration field ineligible on Clairic, and a call with one reads, sends and reserves nothing", async () => {
    const { plan } = await import("../../src/domain/routing.js")
    const { loadConfig } = await import("../../src/domain/config.js")
    const { PlanInput } = await import("../../src/domain/contracts.js")
    const { implemented } = await import("../../src/domain/registry.js")
    expect(CLAIRIC.fieldTypes).not.toContain("duration")
    const planned = plan(PlanInput.parse({ task: "extract", input: { profile: "extract-typed", source: { kind: "text", text: STATE }, fields: { took: { type: "duration" } } } }), { config: loadConfig({}), fixture: OPENROUTER_CAPABILITIES, implemented, now: new Date() })
    expect(planned.route.selected!.exclusions).toContain("FIELD_TYPE_UNSUPPORTED")

    const { probeHarness, probeRoute } = await import("../support/operation-kit.js")
    const { ExtractResult } = await import("../../src/domain/contracts.js")
    const { writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const tool = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
    const route = probeRoute({ ...CLAIRIC, enabled: true, pricing: { revision: "test", currency: "USD", perRequest: "0.004", upperBound: true } })
    const harness = await probeHarness({ route, tool, adapter: extractionsAdapter, options: { profiles: { probe: { model: "cloudflare/clairic" } } } })
    writeFileSync(join(harness.project, "invoice.txt"), "Paid within 30 days.")
    const error = await Promise.resolve(harness.model({ profile: "probe", source: { kind: "path", path: "invoice.txt" }, fields: { took: { type: "duration" } } })).then(() => undefined, (caught: Error) => caught)
    expect(error?.message).toMatch(/^CAPABILITY_UNSUPPORTED: /)
    expect(harness.counts.read).toBe(0)
    expect(harness.sent).toEqual([])
    expect(await harness.journal.list()).toEqual([])
  })
})

describe("reservations for per-token prices", () => {
  test("a per-token-priced route without a documented ceiling reserves the whole per-request budget you set, as an estimate", async () => {
    const { probeHarness, probeRoute } = await import("../support/operation-kit.js")
    const { ExtractResult } = await import("../../src/domain/contracts.js")
    const tool = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
    const run = async (pricing: RouteCapability["pricing"]) => {
      const harness = await probeHarness({ route: probeRoute({ ...CLAIRIC, enabled: true, pricing }), tool, adapter: extractionsAdapter, options: { profiles: { probe: { model: "cloudflare/clairic" } }, spend: { requestUsd: "0.05" } } })
      harness.replies.push(answer(FIXTURE))
      await harness.model({ profile: "probe", source: { kind: "text", text: STATE }, fields: FIELDS })
      return (await harness.journal.list())[0]!.reservation
    }
    expect(await run({ revision: "t", currency: "USD", perRequest: "0.001", perMillionInputTokens: "0.2", upperBound: true })).toMatchObject({ amount: "0.05", basis: "admission_budget" })
    expect(await run({ revision: "t", currency: "USD", perMillionInputTokens: "0.2", upperBound: false, ceiling: { amount: "0.02", source: "A4" } })).toMatchObject({ amount: "0.02", basis: "upper_bound" })
  })
})
