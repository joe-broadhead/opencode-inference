// The canaries' malformed requests must be invalid by the API references' own schemas, or a 200 says nothing about the
// error path: the earlier decisions body (a one-option choice) was valid to the API, and was answered and billed on
// 2026-11-12. Each body here breaks exactly one documented requirement and keeps every other; the adapter's own
// requests keep all of them, so it can never send either body; and a one-option choice is refused locally.
import { expect, test } from "bun:test"
import { loadConfig } from "../../src/domain/config.js"
import { DecideInput, DecideResult, ExtractInput } from "../../src/domain/contracts.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { decisionsAdapter, WIRE_REVISION as DECISIONS_REVISION } from "../../src/providers/openrouter/decisions.js"
import { extractionsAdapter } from "../../src/providers/openrouter/extractions.js"
import { snapshot, type FileAccess } from "../../src/runtime/sources.js"
import { BREAKS, malformedBody, malformedRequest, SOURCES } from "../../scripts/canary-malformed.js"

// The required keys, as the API references' OpenAPI schemas state them (read 2026-11-12, SOURCES).
const REQUIRED = {
  extractions: { request: ["model", "fields"], field: { text: ["type"], number: ["type"], date: ["type"], list: ["type", "items"] } as Record<string, string[]> },
  decisions: { request: ["model", "state", "questions"], question: { noul: ["type"], choice: ["type", "criteria"], score: ["type", "criteria"] } as Record<string, string[]> },
}

/** Every documented requirement a body breaks, as "<path> lacks <key>". */
function broken(endpoint: "extractions" | "decisions", body: Record<string, any>): string[] {
  const out: string[] = []
  for (const key of REQUIRED[endpoint].request) if (body[key] === undefined) out.push(`request lacks ${key}`)
  const items: Record<string, Record<string, unknown>> = endpoint === "extractions" ? body.fields : body.questions
  const required = endpoint === "extractions" ? REQUIRED.extractions.field : REQUIRED.decisions.question
  for (const [name, item] of Object.entries(items ?? {})) {
    const keys = required[String(item.type)]
    if (!keys) out.push(`${name} has an undocumented type`)
    else for (const key of keys) if (item[key] === undefined) out.push(`${name} lacks ${key}`)
    if (key(item, "criteria") && Array.isArray(item.criteria) && item.criteria.length === 0) out.push(`${name} has no criteria`)
  }
  return out
}
const key = (item: Record<string, unknown>, name: string) => item[name] !== undefined

test("each malformed body breaks exactly one documented requirement, and keeps every other", () => {
  expect(broken("extractions", malformedBody("extractions", "cloudflare/clairic", "a, b"))).toEqual(["names lacks items"])
  expect(broken("decisions", malformedBody("decisions", "typesafe/jev-1.14", "Paid."))).toEqual(["kind lacks criteria"])
  expect(BREAKS.extractions).toContain("`items`")
  expect(BREAKS.decisions).toContain("`criteria`")
  for (const url of Object.values(SOURCES)) expect(url).toMatch(/^https:\/\/openrouter\.ai\/docs\/api\/api-reference\//)
  const request = malformedRequest("decisions", "typesafe/jev-1.14", "Paid.")
  expect(request.path).toBe("/api/alpha/decisions")
  expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual(malformedBody("decisions", "typesafe/jev-1.14", "Paid."))
})

test("the adapter's own requests keep every documented requirement: it can never send a malformed body", async () => {
  const clairic = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "cloudflare/clairic")!
  const text = "Invoice AB-72, total EUR 1.00, items: pens, ink"
  const source = await snapshot({ kind: "text", text }, {} as FileAccess, clairic, new AbortController().signal)
  const fields = { id: { type: "text" }, total: { type: "number", decimals: 2 }, on: { type: "date" }, items: { type: "list", items: "text" } }
  const extraction = JSON.parse(new TextDecoder().decode(extractionsAdapter.request(ExtractInput.parse({ model: clairic.model, source: { kind: "text", text }, fields }), source, clairic).body))
  expect(broken("extractions", extraction)).toEqual([])

  const jev = { ...OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "typesafe/jev-1.14")!, effectiveContextTokens: 4096, contextAllowance: { tokens: 512, source: "test" } }
  const decideSource = await snapshot({ kind: "text", text }, {} as FileAccess, jev, new AbortController().signal)
  const questions = {
    paid: { type: "noul", prompt: "Paid?" },
    kind: { type: "choice", prompt: "Which?", options: [{ id: "invoice", description: "An invoice" }, { id: "other", description: "Other" }] },
    size: { type: "score", prompt: "How large?", levels: [{ id: "small", description: "small" }, { id: "large", description: "large" }] },
  }
  const prepared = decisionsAdapter.prepare!(DecideInput.parse({ model: jev.model, source: { kind: "text", text }, questions }), loadConfig({}))
  expect(broken("decisions", JSON.parse(new TextDecoder().decode(decisionsAdapter.request(prepared, decideSource, jev).body)))).toEqual([])
})

test("a one-option choice (valid to the API, and billed) is refused locally: no answer can be a decision, nothing is sent", async () => {
  const one = { only: { type: "choice", prompt: "Which?", options: [{ id: "one", description: "the only option" }] } }
  expect(DecideInput.safeParse({ model: "typesafe/jev-1.14", source: { kind: "text", text: "Paid." }, questions: one }).success).toBe(false)
  // A one-level score is refused the same way.
  expect(DecideInput.safeParse({ model: "typesafe/jev-1.14", source: { kind: "text", text: "Paid." }, questions: { size: { type: "score", prompt: "How?", levels: [{ id: "only", description: "only" }] } } }).success).toBe(false)
  const { probeHarness, probeRoute } = await import("../support/operation-kit.js")
  const jev = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "typesafe/jev-1.14")!
  const route = probeRoute({ ...jev, enabled: true, canary: { status: "passed", on: "2026-11-12", reports: { request: "decisions-20261112T215015Z.json", malformed: "decisions-20261112T225714Z.json" }, wireRevision: DECISIONS_REVISION }, effectiveContextTokens: 4096, contextAllowance: { tokens: 512, source: "test" }, pricing: { revision: "test", currency: "USD", perRequest: "0.002", upperBound: true } })
  const tool = { name: "decide", class: "send" as const, operation: "decide" as const, module: "decisions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "decide", input: DecideInput, output: DecideResult }
  const harness = await probeHarness({ route, tool, adapter: decisionsAdapter, options: { profiles: { probe: { model: "typesafe/jev-1.14" } } } })
  const error = await Promise.resolve(harness.model({ profile: "probe", source: { kind: "text", text: "Paid." }, questions: one })).then(() => undefined, (caught: Error) => caught)
  expect(error).toBeDefined()
  expect(harness.sent).toEqual([])
  expect(await harness.journal.list()).toEqual([])
})

test("both canaries' dry runs name what the malformed request breaks, and send nothing", () => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "OPENROUTER_CANARY_KEY"))
  for (const [script, endpoint] of [["canary-extractions", "extractions"], ["canary-decisions", "decisions"]] as const) {
    const child = Bun.spawnSync([process.execPath, new URL(`../../scripts/${script}.ts`, import.meta.url).pathname, "--yes-spend", "--budget-usd", "0.10", "--per-call-usd", "0.02", "--only", "malformed", "--dry-run"], {
      env: { ...base, OPENROUTER_CANARY_KEY: "sk-or-v1-malformed-test-not-a-key" } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect({ script, code: child.exitCode }).toEqual({ script, code: 0 })
    const report = JSON.parse(child.stdout.toString()) as { results: { canary: string; would?: string; bytes?: number; breaks?: string }[]; next: string }
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ canary: "malformed", would: `POST /api/alpha/${endpoint}`, bytes: malformedRequest(endpoint, endpoint === "extractions" ? "cloudflare/clairic" : "typesafe/jev-1.14", endpoint === "extractions" ? "a, b" : "Invoice AB-72 for EUR 1.00 was paid on 2026-11-01.").body.byteLength, breaks: BREAKS[endpoint] })
    expect(report.next).toBe("Dry run: nothing was sent.")
  }
}, 60_000)
