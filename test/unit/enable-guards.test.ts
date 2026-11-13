// An enabled route runs only on the wire contract its canary checked: when the adapter's WIRE_REVISION is not the one the
// route's canary recorded, the call refuses with ROUTE_NOT_VERIFIED before the key, the file or the network, and says to
// re-run the canary. An adapter change can never keep a route enabled without a new canary.
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../../src/domain/config.js"
import { ExtractInput, ExtractResult } from "../../src/domain/contracts.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { WIRE_REVISION as DECISIONS_REVISION } from "../../src/providers/openrouter/decisions.js"
import { extractionsAdapter, WIRE_REVISION } from "../../src/providers/openrouter/extractions.js"
import { resolveRoute } from "../../src/runtime/operation.js"
import { probeHarness } from "../support/operation-kit.js"

const CLAIRIC = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "cloudflare/clairic")!
const tool = { name: "extract", class: "send" as const, operation: "extract" as const, module: "extractions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "extract", input: ExtractInput, output: ExtractResult }
const BUMPED = "openrouter-alpha-extractions-2099-01-01.1"
const input = { model: "cloudflare/clairic", source: { kind: "text" as const, text: "Total EUR 1.00" }, fields: { total: { type: "number" as const } } }

test("an adapter whose revision is not the canary's refuses with ROUTE_NOT_VERIFIED: nothing read, sent or reserved", async () => {
  const bumped = { ...extractionsAdapter, revision: BUMPED }
  const probe = await probeHarness({ route: CLAIRIC, tool, adapter: bumped, options: { profiles: { probe: { model: CLAIRIC.model } } } })
  writeFileSync(join(probe.project, "invoice.txt"), "Total EUR 1.00")
  const error = await Promise.resolve(probe.model({ profile: "probe", source: { kind: "path", path: "invoice.txt" }, fields: { total: { type: "number" } } })).then(() => undefined, (caught: Error) => caught)
  expect(error?.message).toStartWith("ROUTE_NOT_VERIFIED: cloudflare/clairic's compatibility canary passed against wire revision openrouter-alpha-extractions-2026-11-12.2")
  expect(error?.message).toContain(BUMPED)
  expect(error?.message).toContain("Re-run the compatibility canary for this revision")
  expect(probe.counts).toEqual({ inspect: 0, read: 0 })
  expect(probe.sent).toEqual([])
  expect(await probe.journal.list()).toEqual([])
  // The tools RPC says the same, by code.
  const scripted = (await probe.rpc({ profile: "probe", source: { kind: "text", text: "Total EUR 1.00" }, fields: { total: { type: "number" } } })) as { error: { data: { code: string } } }
  expect(scripted.error.data.code).toBe("ROUTE_NOT_VERIFIED")
})

test("the committed route resolves under its adapter's own revision; any other revision, or none recorded, refuses", () => {
  const config = loadConfig({})
  expect(CLAIRIC.canary.wireRevision).toBe(WIRE_REVISION)
  expect(resolveRoute("extract", input, config, OPENROUTER_CAPABILITIES, WIRE_REVISION).model).toBe("cloudflare/clairic")
  expect(() => resolveRoute("extract", input, config, OPENROUTER_CAPABILITIES, BUMPED)).toThrow(/^ROUTE_NOT_VERIFIED: /)
  const unrecorded = { ...OPENROUTER_CAPABILITIES, routes: OPENROUTER_CAPABILITIES.routes.map((route) => (route.model === "cloudflare/clairic" ? { ...route, canary: { status: "passed" as const, on: "2026-11-12" } } : route)) }
  expect(() => resolveRoute("extract", input, config, unrecorded, WIRE_REVISION)).toThrow(/^ROUTE_NOT_VERIFIED: .*\(none recorded\)/)
  // A disabled route says it is disabled first, whatever the revision.
  const scaledown = { ...input, model: "scaledown/extract", fields: { name: { type: "text" as const } } }
  expect(() => resolveRoute("extract", scaledown, config, OPENROUTER_CAPABILITIES, BUMPED)).toThrow(/^CAPABILITY_UNSUPPORTED: scaledown\/extract is disabled/)
})

test("both enabled routes resolve on their adapters' current revisions; bumping either adapter's revision makes that route refuse", () => {
  const config = loadConfig({})
  const decideInput = { model: "typesafe/jev-1.14", source: { kind: "text" as const, text: "Paid." }, questions: { paid: { type: "noul" as const, prompt: "Paid?" } } }
  const routes = [
    { operation: "extract" as const, model: "cloudflare/clairic", input, revision: WIRE_REVISION },
    { operation: "decide" as const, model: "typesafe/jev-1.14", input: decideInput, revision: DECISIONS_REVISION },
  ]
  // Exactly these two are enabled, each recording its adapter's current revision.
  expect(OPENROUTER_CAPABILITIES.routes.filter((route) => route.enabled).map((route) => [route.model, route.canary.wireRevision])).toEqual(routes.map((route) => [route.model, route.revision]))
  for (const route of routes) {
    expect(resolveRoute(route.operation, route.input, config, OPENROUTER_CAPABILITIES, route.revision).model).toBe(route.model)
    const bumped = route.revision.replace(/\d+$/, (n) => String(Number(n) + 1))
    expect(bumped).not.toBe(route.revision)
    expect(() => resolveRoute(route.operation, route.input, config, OPENROUTER_CAPABILITIES, bumped)).toThrow(new RegExp(`^ROUTE_NOT_VERIFIED: ${route.model.replace("/", "\\/")}'s compatibility canary`))
  }
})

