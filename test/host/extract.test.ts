// inference_extract end to end on the embedded OpenCode host, against a loopback fake OpenRouter: the same answer on the
// model's tool path (Code Mode, unattended) and the tools RPC, the key sent only to the fake and only in its header,
// and a file source read through the host's own permission. The route is enabled only in this test's fixture; the
// committed fixture keeps every route disabled.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { createPlugin } from "../../src/host/plugin.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { cleanup, HOST_VERSION, REPO, root, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(300_000)
afterAll(cleanup)

const FAKE_KEY = "sk-or-v1-host-extract-fake-key-0123456789"
const FIXTURE = readFileSync(join(REPO, "test/fixtures/providers/openrouter-extractions/clairic-text.json"), "utf8")
const STATE = "\u{1F4B6} Zoé 総額 EUR 120.00\r\nDue: none. Items: pens, ink"
const FIELDS = { name: { type: "text" }, currency: { type: "text", nullThreshold: 0.5 }, total: { type: "number", decimals: 2 }, due_on: { type: "date" }, items: { type: "list", items: "text", maxItems: 5 } }

/** The committed fixture with Clairic enabled and a test price, for this test only. */
const fixture = {
  ...OPENROUTER_CAPABILITIES,
  revision: "host-test-1",
  routes: OPENROUTER_CAPABILITIES.routes.map((route) =>
    route.model === "cloudflare/clairic" ? { ...route, enabled: true, canary: { status: "passed" as const, on: "2026-11-12" }, pricing: { revision: "host-test", currency: "USD" as const, perRequest: "0.004", upperBound: true } } : route,
  ),
}

describe(`inference_extract on OpenCode ${HOST_VERSION} (embedded SDK), against a loopback fake provider`, () => {
  let host: Host
  let server: Server
  let sessionID: string
  const seen: { path: string; authorization: string | undefined; body: Record<string, any> }[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      request.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, any>
        seen.push({ path: request.url ?? "", authorization: request.headers.authorization, body: parsed })
        // Answer text with the fixture; a file source gets an answer for its one field.
        const answer = parsed.state === STATE ? FIXTURE : JSON.stringify({ model: "cloudflare/clairic", id: "gen-file-1", answers: { title: { value: "Quarterly", confidence: 0.8, evidence: [{ start: 0, end: 9 }] } }, usage: { cost: 0.000002 } })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(answer)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    host = await startHost({ plugin: createPlugin({ packageRoot: REPO, fixture, transportOrigin: origin, stateRoot: join(root, "inference-state") }) })
    sessionID = (await host.client.session.create({ agent: "build", location: host.location })).id
    await until("the observer has the location's context", async () => host.context?.() !== undefined)
    await host.client.integration.connect.key({ integrationID: "inference-openrouter", key: FAKE_KEY, label: "Host test", location: host.location })
  })
  afterAll(async () => {
    await host?.close()
    server?.close()
  })

  test("the model's tool path and the tools RPC return the same validated result, and the key goes only to the fake, in its header", async () => {
    const input = { profile: "extract-typed", source: { kind: "text", text: STATE }, fields: FIELDS }
    const script = await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method: "extract", input: { sessionID, input } as never, location: host.location })
    const viaScript = script.output as Record<string, any>
    const message = await (host.client as any).experimental.schedule
      .create({
        sessionID,
        location: host.location,
        name: "extract-check",
        when: { in: "6 hours" },
        if: { code: `const result = await tools.inference.extract(${JSON.stringify(input)})\nthrow new Error("SEEN " + JSON.stringify(result))` },
        prompt: "never wakes",
      })
      .then(() => "created", (error: Error) => error.message)
    const viaModel = JSON.parse(/SEEN (\{.*\})/s.exec(message)?.[1] ?? "null") as Record<string, any>
    expect(viaModel).not.toBeNull()
    for (const result of [viaScript, viaModel]) {
      expect(result).toMatchObject({ schemaVersion: 1, route: { model: "cloudflare/clairic", capabilityRevision: "host-test-1" }, trust: "untrusted", review: { required: true } })
      expect(result.data.fields.currency.evidence[0].textRange).toMatchObject({ start: 10, end: 13, unit: "unicode-code-point" })
      expect(result.data.fields.due_on).toMatchObject({ value: null, guess: "2026-12-01", derivation: "unknown" })
      expect(result.usage.charges).toEqual([{ party: "platform", currency: "USD", amount: "0.000012345679", basis: "reported" }])
    }
    expect(viaModel.data).toEqual(viaScript.data)
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.path).toBe("/api/alpha/extractions")
      expect(request.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(request.body).toMatchObject({ model: "cloudflare/clairic", state: STATE, provider: { allow_fallbacks: false } })
    }
    expect(JSON.stringify([viaScript, viaModel])).not.toContain(FAKE_KEY)
  })

  test("a file source is read through the host's permission and snapshotted; the request carries its text", async () => {
    writeFileSync(join(host.location.directory, "report.txt"), "Quarterly report")
    const input = { profile: "extract-typed", source: { kind: "path", path: "report.txt" }, fields: { title: { type: "text" } } }
    const result = (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method: "extract", input: { sessionID, input } as never, location: host.location })).output as Record<string, any>
    expect(result.data.fields.title).toMatchObject({ value: "Quarterly", evidence: [{ basis: "exact-text", textRange: { start: 0, end: 9 } }] })
    expect(seen.at(-1)!.body.state).toBe("Quarterly report")
    expect(result.usage.charges[0].amount).toBe("0.000002")
  })
})
