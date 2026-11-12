// cloudflare/clairic is enabled for text after its compatibility canary passed on 2026-11-12 (the request canary in run
// 3, extractions-20261112T215014Z.json, and the malformed-request canary in run 4, extractions-20261112T225713Z.json,
// both against wire revision openrouter-alpha-extractions-2026-11-12.2). The committed route plans, sends and settles;
// its images, never observed by the canary, stay refused; a disabled sibling still refuses; and the catalog price
// reproduces the canary's reported cost exactly.
import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../../src/domain/config.js"
import { ExtractInput, ExtractResult, PlanInput } from "../../src/domain/contracts.js"
import { format, money } from "../../src/domain/money.js"
import { implemented } from "../../src/domain/registry.js"
import { plan } from "../../src/domain/routing.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { extractionsAdapter, WIRE_REVISION } from "../../src/providers/openrouter/extractions.js"
import { probeHarness } from "../support/operation-kit.js"

const CLAIRIC = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "cloudflare/clairic")!
const SCALEDOWN = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "scaledown/extract")!
const FIXTURE = readFileSync(new URL("../fixtures/providers/openrouter-extractions/clairic-text.json", import.meta.url), "utf8")
const STATE = "\u{1F4B6} Zoé 総額 EUR 120.00\r\nDue: none. Items: pens, ink"
const FIELDS = { name: { type: "text" }, currency: { type: "text", nullThreshold: 0.5 }, total: { type: "number", decimals: 2, required: true }, due_on: { type: "date" }, items: { type: "list", items: "text", maxItems: 5 } }
const tool = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
const answer = (body: string) => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(body), elapsedMs: 5 })
const harness = (route = CLAIRIC) => probeHarness({ route, tool, adapter: extractionsAdapter, options: { profiles: { probe: { model: route.model } } } })

test("the committed route records its canary: passed on 2026-11-12, both reports, against the adapter's current wire revision", () => {
  expect(CLAIRIC).toMatchObject({
    enabled: true,
    canary: { status: "passed", on: "2026-11-12", reports: ["extractions-20261112T215014Z.json", "extractions-20261112T225713Z.json"], wireRevision: WIRE_REVISION },
    inputs: { text: true, images: null, pdf: null },
    effectiveContextTokens: 65536,
    contextAllowance: null,
    pricing: { revision: "openrouter-catalog-2026-11-12", currency: "USD", perMillionInputTokens: "0.1", perMillionOutputTokens: "0", upperBound: false },
  })
  expect(CLAIRIC.pricing!.ceiling).toBeUndefined()
  expect(OPENROUTER_CAPABILITIES.sources.find((source) => source.id === "C1")!.url).toBe("https://openrouter.ai/api/v1/models")
})

test("the catalog price reproduces the canary's reported cost exactly: 125 input tokens at 0.0000001, output free", () => {
  // Run 3 reported usage { inputTokens: 125, outputTokens: 0 } and a charge of 0.0000125 (extractions-20261112T215014Z.json).
  const perToken = (perMillion: string, tokens: bigint) => money(perMillion).units * tokens
  const exact = perToken(CLAIRIC.pricing!.perMillionInputTokens!, 125n) + perToken(CLAIRIC.pricing!.perMillionOutputTokens!, 0n)
  expect(exact % 1_000_000n).toBe(0n)
  expect(format({ currency: "USD", units: exact / 1_000_000n })).toBe("0.0000125")
})

test("the enabled route plans and sends: one request to the reviewed path, an estimate that reserves the whole per-request budget, settled at the reported charge", async () => {
  const planned = plan(PlanInput.parse({ task: "extract", input: { profile: "extract-typed", source: { kind: "text", text: STATE }, fields: FIELDS } }), { config: loadConfig({}), fixture: OPENROUTER_CAPABILITIES, implemented, now: new Date("2026-11-12T00:00:00Z") })
  expect(planned).toMatchObject({ route: { status: "eligible", selected: { route: { model: "cloudflare/clairic" }, exclusions: [] } }, execution: { available: true }, quote: { kind: "estimate" } })
  const probe = await harness()
  probe.replies.push(answer(FIXTURE))
  const result = (await probe.model({ profile: "probe", source: { kind: "text", text: STATE }, fields: FIELDS })) as { output: { data: { fields: Record<string, unknown> } } }
  expect(ExtractResult.safeParse(result.output).success).toBe(true)
  expect(probe.sent.map((request) => request.path)).toEqual(["/api/alpha/extractions"])
  expect(JSON.parse(new TextDecoder().decode(probe.sent[0]!.body))).toMatchObject({ model: "cloudflare/clairic", state: STATE, provider: { allow_fallbacks: false } })
  const [record] = await probe.journal.list()
  expect(record!.reservation).toMatchObject({ amount: "0.05", basis: "admission_budget", status: "settled" })
  expect(record!.charges[0]!.amount).toBe("0.000012345679")
})

test("its images, never observed by the canary, are refused before the file is read; a disabled sibling still refuses", async () => {
  const image = await harness()
  writeFileSync(join(image.project, "scan.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const refused = await Promise.resolve(image.model({ profile: "probe", source: { kind: "path", path: "scan.png" }, fields: { name: { type: "text" } } })).then(() => undefined, (error: Error) => error)
  expect(refused?.message).toMatch(/^CAPABILITY_UNSUPPORTED: /)
  expect(image.counts.read).toBe(0)
  expect(image.sent).toEqual([])
  // ScaleDown, disabled: refused at the route, nothing sent or reserved.
  expect(SCALEDOWN.enabled).toBe(false)
  const sibling = await harness(SCALEDOWN)
  const declined = await Promise.resolve(sibling.model({ profile: "probe", source: { kind: "text", text: STATE }, fields: { name: { type: "text" } } })).then(() => undefined, (error: Error) => error)
  expect(declined?.message).toMatch(/^CAPABILITY_UNSUPPORTED: scaledown\/extract is disabled/)
  expect(sibling.sent).toEqual([])
  expect(await sibling.journal.list()).toEqual([])
})
