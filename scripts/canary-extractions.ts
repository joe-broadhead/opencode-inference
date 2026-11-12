#!/usr/bin/env bun
// The opt-in compatibility canary for OpenRouter's alpha Extractions routes (handoff §7.3, §17.3). It SPENDS money and
// is never run by `npm run check` or CI. It refuses to start unless every one of these is given:
//
//   OPENROUTER_CANARY_KEY=<key>   an OpenRouter key in the environment, used only for this run (ideally a key with its
//                                 own credit limit on OpenRouter: that limit is the stronger, independent cap)
//   --budget-usd <amount>         the most this run may spend, at most 0.10
//   --per-call-usd <amount>       the most one call may cost (its worst case), at most the budget
//   --yes-spend                   an explicit acknowledgement that the run sends requests that are charged
//
// and it refuses in CI (CI set). Separate canaries, chosen with --only (default: all):
//   catalog    GET /api/v1/models?endpoints=/api/alpha/extractions, without the key, and report drift (catalog.ts)
//   text       one tiny Clairic text extraction, validated by the adapter's strict response schema
//   image      one 1x1 PNG Clairic extraction
//   pdf        one tiny PDF ScaleDown extraction
//   malformed  a Clairic request that breaks a documented constraint (null_threshold on a list): OpenRouter should refuse it
//
// At most four POSTs, each through the plugin's own transport and adapter. Before each POST the spend so far plus the
// call's worst case must fit the budget, so the run cannot overshoot it by its own accounting; after it, the reported
// charge is counted whatever the HTTP status, or the worst case when none is reported (canary-budget.ts). --dry-run prints what would be sent and sends nothing. It prints a JSON report with the suggested canary
// status per route; it never edits the fixture or enables a route: a person reviews the report and changes the fixture.
import { ExtractInput } from "../src/domain/contracts.js"
import { InferenceError } from "../src/domain/errors.js"
import { compare, format, money } from "../src/domain/money.js"
import { catalogDrift, catalogModels } from "../src/providers/openrouter/catalog.js"
import { OPENROUTER_CAPABILITIES, type RouteCapability } from "../src/providers/openrouter/capabilities.js"
import { extractionsAdapter } from "../src/providers/openrouter/extractions.js"
import { createTransport, OPENROUTER_ORIGIN, TransportError } from "../src/providers/openrouter/http.js"
import { snapshot, type FileAccess, type Snapshot } from "../src/runtime/sources.js"
import { CanaryBudget } from "./canary-budget.js"

const CANARIES = ["catalog", "text", "image", "pdf", "malformed"] as const
type Canary = (typeof CANARIES)[number]
const MAX_BUDGET = money("0.10")

function refuse(reason: string): never {
  console.error(`canary-extractions: refused: ${reason}`)
  console.error("usage: OPENROUTER_CANARY_KEY=<key> bun scripts/canary-extractions.ts --budget-usd <at most 0.10> --per-call-usd <worst case per call> --yes-spend [--only text,image,pdf,malformed,catalog] [--dry-run]")
  process.exit(2)
}

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
for (const arg of args) if (arg.startsWith("--") && !["--budget-usd", "--per-call-usd", "--yes-spend", "--only", "--dry-run"].includes(arg)) refuse(`unknown option ${arg}`)
if (process.env.CI) refuse("CI is set: the canary spends money and never runs in CI")
if (!flag("--yes-spend")) refuse("--yes-spend is required: the canary sends requests that are charged")
const budgetText = value("--budget-usd")
if (budgetText === undefined) refuse("--budget-usd is required")
let budget
try {
  budget = money(budgetText)
} catch {
  refuse("--budget-usd must be an exact decimal such as 0.02")
}
if (compare(budget, MAX_BUDGET) > 0) refuse("--budget-usd is above the canary's ceiling of 0.10")
if (budget.units === 0n) refuse("--budget-usd must be above zero")
const perCallText = value("--per-call-usd")
if (perCallText === undefined) refuse("--per-call-usd is required: the worst case of one call, checked before each call")
let perCall
try {
  perCall = money(perCallText)
} catch {
  refuse("--per-call-usd must be an exact decimal such as 0.005")
}
if (perCall.units === 0n || compare(perCall, budget) > 0) refuse("--per-call-usd must be above zero and at most --budget-usd")
const spend = new CanaryBudget(budget, perCall)
const key = process.env.OPENROUTER_CANARY_KEY
if (!key) refuse("OPENROUTER_CANARY_KEY is not set: the canary uses only an explicitly given key, never OpenCode's")
const only = (value("--only") ?? CANARIES.join(",")).split(",")
for (const name of only) if (!(CANARIES as readonly string[]).includes(name)) refuse(`unknown canary ${name}`)
const selected = new Set(only as Canary[])
const dryRun = flag("--dry-run")

const route = (model: string): RouteCapability => {
  const found = OPENROUTER_CAPABILITIES.routes.find((item) => item.model === model && item.operation === "extract")
  if (!found) throw new Error(`${model} is not in the fixture`)
  return found
}
const noFiles = {} as FileAccess
const signal = new AbortController().signal
const image = (mimeType: string, bytes: Uint8Array, modality: "image" | "pdf"): Snapshot => ({
  origin: "path",
  modality,
  mimeType,
  bytes: bytes.byteLength,
  sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  content: () => bytes.slice(),
  text: () => {
    throw new Error("not text")
  },
})
// A 1x1 transparent PNG and a minimal one-page PDF, built here: no file is read.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 50]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")

interface Case {
  readonly canary: Exclude<Canary, "catalog">
  readonly route: RouteCapability
  readonly input: unknown
  readonly source: () => Promise<Snapshot>
  /** True when OpenRouter is expected to refuse the request. */
  readonly refused?: boolean
}
const cases: Case[] = [
  { canary: "text", route: route("cloudflare/clairic"), input: { model: "cloudflare/clairic", source: { kind: "text", text: "Total EUR 1.00" }, fields: { total: { type: "number", decimals: 2 } } }, source: () => snapshot({ kind: "text", text: "Total EUR 1.00" }, noFiles, route("cloudflare/clairic"), signal) },
  { canary: "image", route: route("cloudflare/clairic"), input: { model: "cloudflare/clairic", source: { kind: "text", text: "-" }, fields: { caption: { type: "text" } } }, source: async () => image("image/png", PNG, "image") },
  { canary: "pdf", route: route("scaledown/extract"), input: { model: "scaledown/extract", source: { kind: "text", text: "-" }, fields: { title: { type: "text" } } }, source: async () => image("application/pdf", PDF, "pdf") },
  // Built by hand: the adapter refuses this request locally, which is the point; the canary checks OpenRouter does too.
  { canary: "malformed", route: route("cloudflare/clairic"), input: { model: "cloudflare/clairic", source: { kind: "text", text: "a, b" }, fields: { names: { type: "list", items: "text" } } }, source: () => snapshot({ kind: "text", text: "a, b" }, noFiles, route("cloudflare/clairic"), signal), refused: true },
]

const report: Record<string, unknown> = { at: new Date().toISOString(), origin: OPENROUTER_ORIGIN, budgetUsd: format(budget), perCallUsd: format(perCall), dryRun }

if (selected.has("catalog")) {
  if (dryRun) report["catalog"] = { would: "GET /api/v1/models?endpoints=/api/alpha/extractions (no key)" }
  else {
    const response = await fetch(`${OPENROUTER_ORIGIN}/api/v1/models?endpoints=/api/alpha/extractions`, { redirect: "error", signal: AbortSignal.timeout(20_000) })
    report["catalog"] = catalogDrift(OPENROUTER_CAPABILITIES, "extract", catalogModels(await response.json()))
  }
}

const integration = {
  connection: {
    active: async () => ({ type: "credential", id: "canary", label: "canary", method: "key" }) as never,
    resolve: async () => ({ type: "key", key }) as never,
    status: async () => undefined,
  },
}
const transport = createTransport(integration as never)
const results: Record<string, unknown>[] = []
for (const item of cases) {
  if (!selected.has(item.canary)) continue
  const source = await item.source()
  const input = ExtractInput.parse(item.input)
  let request: { path: string; body: Uint8Array }
  if (item.refused) {
    const body = { model: item.route.model, state: source.text(), fields: { names: { type: "list", items: { type: "text" }, null_threshold: 0.5 } }, provider: { allow_fallbacks: false } }
    request = { path: "/api/alpha/extractions", body: new TextEncoder().encode(JSON.stringify(body)) }
  } else request = extractionsAdapter.request(input, source, item.route)
  // The worst case must fit BEFORE the call, in a dry run too, so the report shows what a real run would skip.
  if (!spend.canAfford()) {
    results.push({ canary: item.canary, model: item.route.model, skipped: "the remaining budget cannot cover this call's worst case" })
    continue
  }
  if (dryRun) {
    spend.record(undefined)
    results.push({ canary: item.canary, model: item.route.model, would: `POST ${request.path}`, bytes: request.body.byteLength, counted: format(perCall) })
    continue
  }
  const account = await transport.account()
  if (account === undefined || account === "needs_auth") throw new Error("the canary key is not usable")
  let answer: Uint8Array | undefined
  try {
    const response = await transport.post({ ...request, account, deadlineMs: 30_000, maxRequestBytes: 16 * 1024 * 1024, maxResponseBytes: 1024 * 1024, signal })
    answer = response.body
    const ok = response.status >= 200 && response.status <= 299
    if (item.refused || !ok) {
      // An error answer can still be charged: count what it reports, or the worst case.
      const counted = spend.recordAnswer(answer)
      results.push({ canary: item.canary, model: item.route.model, status: response.status, passed: item.refused ? response.status >= 400 && response.status < 500 : false, counted })
      continue
    }
    const parsed = extractionsAdapter.parse(response, { source, route: item.route, input })
    const usd = parsed.usage.charges.filter((charge) => charge.currency === "USD")
    const counted = parsed.usage.costStatus !== "known" || usd.length === 0 ? spend.record(undefined) : usd.map((charge) => spend.record(charge.amount)).join(" + ")
    results.push({ canary: item.canary, model: item.route.model, status: response.status, passed: true, usage: parsed.usage, review: parsed.review.reasons, counted })
  } catch (error) {
    // A request that may have left is counted: what its answer reports, or the worst case. One that did not, is not.
    const sent = !(error instanceof TransportError) || error.sent
    const counted = sent ? spend.recordAnswer(answer) : "0"
    const reason = error instanceof InferenceError ? error.code : error instanceof TransportError ? `transport ${error.kind}` : "error"
    results.push({ canary: item.canary, model: item.route.model, passed: false, reason, counted })
  }
}
report["results"] = results
report["spentUsd"] = spend.total
report["next"] = dryRun
  ? "Dry run: nothing was sent."
  : "Review the results. Record a passed canary in src/providers/openrouter/capabilities.ts (route.canary and a new revision) in its own reviewed change; the canary never edits the fixture or enables a route."
console.log(JSON.stringify(report, null, 2))
