// typesafe/jev-1.14 is enabled for noul, choice and score over text after its compatibility canary passed on
// 2026-11-12 (the request canary in run 3, decisions-20261112T215015Z.json, and the malformed-request canary in run 4,
// decisions-20261112T225714Z.json, both against wire revision openrouter-alpha-decisions-2026-11-12.2). The committed
// route plans, sends and settles; a request above its reviewed context is refused before anything is sent; a disabled
// sibling still refuses; and the catalog price reproduces the canary's reported cost exactly.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { loadConfig } from "../../src/domain/config.js"
import { DecideInput, DecideResult, ExtractInput, ExtractResult, PlanInput } from "../../src/domain/contracts.js"
import { format, money } from "../../src/domain/money.js"
import { implemented } from "../../src/domain/registry.js"
import { plan } from "../../src/domain/routing.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { decisionsAdapter, WIRE_REVISION } from "../../src/providers/openrouter/decisions.js"
import { extractionsAdapter } from "../../src/providers/openrouter/extractions.js"
import { probeHarness } from "../support/operation-kit.js"

const JEV = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "typesafe/jev-1.14")!
const SCALEDOWN = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "scaledown/extract")!
const FIXTURE = readFileSync(new URL("../fixtures/providers/openrouter-decisions/jev-text.json", import.meta.url), "utf8")
const STATE = "Payment received for invoice AB-72. Thank you."
const QUESTIONS = {
  kind: { type: "choice", prompt: "Which document category fits?", options: [{ id: "invoice", description: "A request for payment" }, { id: "receipt", description: "Proof of payment" }, { id: "other", description: "Other" }] },
  paid: { type: "noul", prompt: "Has it been paid?" },
  urgency: { type: "score", prompt: "How urgent?", levels: [{ id: "low", description: "low" }, { id: "mid", description: "mid" }, { id: "high", description: "high" }] },
  language: { type: "choice", prompt: "Which language?", options: [{ id: "en", description: "English" }, { id: "de", description: "German" }] },
}
const decide = { name: "decide", class: "send" as const, operation: "decide" as const, module: "decisions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "decide", input: DecideInput, output: DecideResult }
const extract = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
const answer = (body: string) => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(body), elapsedMs: 5 })

test("the committed route records its canary, its reviewed context with its source, and the catalog's price", () => {
  expect(JEV).toMatchObject({
    enabled: true,
    canary: { status: "passed", on: "2026-11-12", reports: { request: "decisions-20261112T215015Z.json", malformed: "decisions-20261112T225714Z.json" }, wireRevision: WIRE_REVISION },
    inputs: { text: true, images: null, pdf: null },
    questionTypes: ["noul", "choice", "score"],
    effectiveContextTokens: 32000,
    contextAllowance: { tokens: 0, source: "T1" },
    pricing: { revision: "openrouter-catalog-2026-11-12", currency: "USD", perMillionInputTokens: "0.042", perMillionOutputTokens: "0", upperBound: false },
  })
  expect(JEV.pricing!.ceiling).toBeUndefined()
  expect(OPENROUTER_CAPABILITIES.sources.find((source) => source.id === "T1")!.url).toBe("https://docs.typesafe.ai/models.md")
})

test("the catalog price reproduces the canary's reported cost exactly: 399 input tokens at 0.000000042, output free", () => {
  // Run 3 reported usage { inputTokens: 399, outputTokens: 61 } and a charge of 0.000016758 (decisions-20261112T215015Z.json).
  const exact = money(JEV.pricing!.perMillionInputTokens!).units * 399n + money(JEV.pricing!.perMillionOutputTokens!).units * 61n
  expect(exact % 1_000_000n).toBe(0n)
  expect(format({ currency: "USD", units: exact / 1_000_000n })).toBe("0.000016758")
})

test("the enabled route plans and sends: one request to the reviewed path, with no cap set the estimate's top reserved, settled at the reported charge; every answer goes to review", async () => {
  const planned = plan(PlanInput.parse({ task: "decide", input: { profile: "decide-text", source: { kind: "text", text: STATE }, questions: QUESTIONS } }), { config: loadConfig({}), fixture: OPENROUTER_CAPABILITIES, implemented, now: new Date("2026-11-12T00:00:00Z") })
  expect(planned).toMatchObject({ route: { status: "eligible", selected: { route: { model: "typesafe/jev-1.14" }, exclusions: [] } }, execution: { available: true }, quote: { kind: "estimate" } })
  const probe = await probeHarness({ route: JEV, tool: decide, adapter: decisionsAdapter, options: { profiles: { probe: { model: JEV.model } } } })
  probe.replies.push(answer(FIXTURE))
  const result = (await probe.model({ profile: "probe", source: { kind: "text", text: STATE }, questions: QUESTIONS })) as { output: { data: { answers: Record<string, { acceptance: { disposition: string } }> } } }
  expect(DecideResult.safeParse(result.output).success).toBe(true)
  // review-first-v1 accepts nothing: every answer is reviewed or refused.
  expect(Object.values(result.output.data.answers).map((item) => item.acceptance.disposition).sort()).toEqual(["refused", "review", "review", "review"])
  expect(probe.sent.map((request) => request.path)).toEqual(["/api/alpha/decisions"])
  const [record] = await probe.journal.list()
  expect(record!.reservation).toMatchObject({ amount: "0.000023142", basis: "admission_budget", status: "settled" })
  expect(record!.charges[0]!.amount).toBe("0.000042000001")
})

test("a request above the reviewed context (32000 bytes of state and questions) is refused before anything is sent", async () => {
  const probe = await probeHarness({ route: JEV, tool: decide, adapter: decisionsAdapter, options: { profiles: { probe: { model: JEV.model } } } })
  const long = `${"x".repeat(32_000)} Paid.`
  const refused = await Promise.resolve(probe.model({ profile: "probe", source: { kind: "text", text: long }, questions: { paid: { type: "noul", prompt: "Paid?" } } })).then(() => undefined, (error: Error) => error)
  expect(refused?.message).toMatch(/^CONTEXT_LIMIT: /)
  expect(probe.sent).toEqual([])
  expect(await probe.journal.list()).toEqual([])
  // Just inside the limit, the request goes.
  probe.replies.push(answer(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers: { paid: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 0, cost: 0.0000001 } })))
  await probe.model({ profile: "probe", source: { kind: "text", text: "x".repeat(31_000) }, questions: { paid: { type: "noul", prompt: "Paid?" } } })
  expect(probe.sent).toHaveLength(1)
})

test("a disabled sibling still refuses: ScaleDown, at the route, nothing sent or reserved", async () => {
  expect(SCALEDOWN.enabled).toBe(false)
  const sibling = await probeHarness({ route: SCALEDOWN, tool: extract, adapter: extractionsAdapter, options: { profiles: { probe: { model: SCALEDOWN.model } } } })
  const declined = await Promise.resolve(sibling.model({ profile: "probe", source: { kind: "text", text: STATE }, fields: { name: { type: "text" } } })).then(() => undefined, (error: Error) => error)
  expect(declined?.message).toMatch(/^CAPABILITY_UNSUPPORTED: scaledown\/extract is disabled/)
  expect(sibling.sent).toEqual([])
  expect(await sibling.journal.list()).toEqual([])
})
