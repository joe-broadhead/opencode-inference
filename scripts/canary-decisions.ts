#!/usr/bin/env bun
// The opt-in compatibility canary for OpenRouter's alpha Decisions route (typesafe/jev-1.14). It SPENDS money and is
// never run by `npm run check` or CI. It refuses to start without OPENROUTER_CANARY_KEY, --budget-usd (at most 0.10),
// --per-call-usd (the worst case of one call, at most the budget) and --yes-spend, and refuses in CI (canary-cli.ts).
// Separate canaries, chosen with --only (default: all):
//   catalog    GET /api/v1/models?endpoints=/api/alpha/decisions, without the key, and report drift (catalog.ts)
//   text       one tiny request with a noul, a choice and a score question, validated by the adapter's strict schema
//              (distributions kept as reported, refusal allowed)
//   malformed  a choice question without its required `criteria` (canary-malformed.ts), which breaks the API reference's
//              own schema: OpenRouter must refuse it with a 4xx. (A one-option choice is valid to the API: it was
//              accepted and billed on 2026-11-12, so it is no malformed request.)
//
// The effective context cannot be measured cheaply here: the fixture's effectiveContextTokens stays as reviewed by a
// person. Before each POST the spend so far plus the call's worst case must fit the budget; after it, the reported
// charge counts whatever the HTTP status, or the worst case when none is reported. --dry-run sends nothing. The report
// suggests a canary status; it never edits the fixture or enables a route. --shape adds each answer's structure and the
// adapter's exact refusal, never a value (canary-shape.ts); it reads only answers already paid for.
import { DecideInput } from "../src/domain/contracts.js"
import { loadConfig } from "../src/domain/config.js"
import { InferenceError } from "../src/domain/errors.js"
import { format } from "../src/domain/money.js"
import { catalogDrift, catalogModels } from "../src/providers/openrouter/catalog.js"
import { OPENROUTER_CAPABILITIES } from "../src/providers/openrouter/capabilities.js"
import { decisionsAdapter } from "../src/providers/openrouter/decisions.js"
import { createTransport, OPENROUTER_ORIGIN, TransportError } from "../src/providers/openrouter/http.js"
import { snapshot, type FileAccess } from "../src/runtime/sources.js"
import { canaryArgs, provenance } from "./canary-cli.js"
import { BREAKS, malformedRequest } from "./canary-malformed.js"
import { failureOf, shapeOf } from "./canary-shape.js"

const CANARIES = ["catalog", "text", "malformed"] as const
const { key, budget, perCall, spend, selected, dryRun, shape } = canaryArgs("canary-decisions", CANARIES, process.argv.slice(2), process.env)

const fixtureRoute = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "typesafe/jev-1.14" && route.operation === "decide")!
// The canary sends a tiny state; the reviewed limit is not known, so it uses a small, safe one for this request only.
const route = { ...fixtureRoute, effectiveContextTokens: fixtureRoute.effectiveContextTokens ?? 2048, contextAllowance: fixtureRoute.contextAllowance ?? { tokens: 1024, source: "canary request only" } }
const STATE = "Invoice AB-72 for EUR 1.00 was paid on 2026-11-01."
const QUESTIONS = {
  paid: { type: "noul", prompt: "Has the invoice been paid?" },
  kind: { type: "choice", prompt: "Which document is this?", options: [{ id: "invoice", description: "An invoice" }, { id: "other", description: "Something else" }] },
  amount: { type: "score", prompt: "How large is the amount?", levels: [{ id: "small", description: "under 10" }, { id: "medium", description: "10 to 1000" }, { id: "large", description: "over 1000" }] },
}
const config = loadConfig({})
// Every report names the wire revision it checks and the commit it ran from: a pass is evidence for those only.
const report: Record<string, unknown> = { at: new Date().toISOString(), wireRevision: decisionsAdapter.revision, ...provenance(), origin: OPENROUTER_ORIGIN, budgetUsd: format(budget), perCallUsd: format(perCall), dryRun, shape }

if (selected.has("catalog")) {
  if (dryRun) report["catalog"] = { would: "GET /api/v1/models?endpoints=/api/alpha/decisions (no key)" }
  else {
    const response = await fetch(`${OPENROUTER_ORIGIN}/api/v1/models?endpoints=/api/alpha/decisions`, { redirect: "error", signal: AbortSignal.timeout(20_000) })
    report["catalog"] = catalogDrift(OPENROUTER_CAPABILITIES, "decide", catalogModels(await response.json()))
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
const source = await snapshot({ kind: "text", text: STATE }, {} as FileAccess, route, new AbortController().signal)
const results: Record<string, unknown>[] = []
for (const canary of ["text", "malformed"] as const) {
  if (!selected.has(canary)) continue
  const input = decisionsAdapter.prepare!(DecideInput.parse({ model: route.model, source: { kind: "text", text: STATE }, questions: QUESTIONS }), config)
  const request =
    canary === "text"
      ? decisionsAdapter.request(input, source, route)
      : // Built by hand: the adapter cannot build a request its own contract and the API reference call invalid.
        malformedRequest("decisions", route.model, STATE)
  if (!spend.canAfford()) {
    results.push({ canary, skipped: "the remaining budget cannot cover this call's worst case" })
    continue
  }
  if (dryRun) {
    spend.record(undefined)
    results.push({ canary, would: `POST ${request.path}`, bytes: request.body.byteLength, counted: format(perCall), ...(canary === "malformed" ? { breaks: BREAKS.decisions } : {}), ...(shape ? { shape: "would record the answer's structure" } : {}) })
    continue
  }
  const account = await transport.account()
  if (account === undefined || account === "needs_auth") throw new Error("the canary key is not usable")
  let answer: Uint8Array | undefined
  let structure: ReturnType<typeof shapeOf> | undefined
  try {
    const response = await transport.post({ ...request, account, deadlineMs: 30_000, maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024, signal: new AbortController().signal })
    answer = response.body
    // --shape: the answer's structure, never its values (canary-shape.ts). Read from the answer already paid for.
    if (shape) structure = shapeOf(response)
    const ok = response.status >= 200 && response.status <= 299
    if (canary === "malformed" || !ok) {
      const counted = spend.recordAnswer(answer)
      results.push({ canary, status: response.status, passed: canary === "malformed" ? response.status >= 400 && response.status < 500 : false, counted, ...(canary === "malformed" ? { breaks: BREAKS.decisions } : {}), ...(structure ? { shape: structure } : {}) })
      continue
    }
    const parsed = decisionsAdapter.parse(response, { source, route, input })
    const usd = parsed.usage.charges.filter((charge) => charge.currency === "USD")
    const counted = parsed.usage.costStatus !== "known" || usd.length === 0 ? spend.record(undefined) : usd.map((charge) => spend.record(charge.amount)).join(" + ")
    results.push({ canary, status: response.status, passed: true, answers: parsed.data, usage: parsed.usage, counted, ...(structure ? { shape: structure } : {}) })
  } catch (error) {
    const sent = !(error instanceof TransportError) || error.sent
    const counted = sent ? spend.recordAnswer(answer) : "0"
    const reason = error instanceof InferenceError ? error.code : error instanceof TransportError ? `transport ${error.kind}` : "error"
    results.push({ canary, passed: false, reason, counted, ...(shape ? { failure: failureOf(error, answer), ...(structure ? { shape: structure } : {}) } : {}) })
  }
}
report["results"] = results
report["spentUsd"] = spend.total
report["next"] = dryRun
  ? "Dry run: nothing was sent."
  : "Review the results. Record a passed canary, the reviewed effective context and real prices in src/providers/openrouter/capabilities.ts in their own reviewed change; the canary never edits the fixture or enables a route."
console.log(JSON.stringify(report, null, 2))
