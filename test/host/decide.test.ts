// inference_decide end to end on the embedded OpenCode host, against a loopback fake OpenRouter: the same answer on the
// model's tool path (Code Mode, unattended) and the tools RPC, the key only in its header, a versioned question set and
// an evaluated automatic profile from the plugin options. Jev is enabled only in this test's fixture.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { questionSetDigest, type QuestionSet } from "../../src/domain/acceptance.js"
import { createPlugin } from "../../src/host/plugin.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { cleanup, HOST_VERSION, REPO, root, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(300_000)
afterAll(cleanup)

const FAKE_KEY = "sk-or-v1-host-decide-fake-key-0123456789"
const FIXTURE = readFileSync(join(REPO, "test/fixtures/providers/openrouter-decisions/jev-text.json"), "utf8")
const STATE = "Payment received for invoice AB-72. Thank you."
const SET: QuestionSet = {
  questions: {
    kind: { type: "choice", prompt: "Which document category fits?", options: [{ id: "invoice", description: "A request for payment" }, { id: "receipt", description: "Proof of payment" }, { id: "other", description: "Other" }] },
    paid: { type: "noul", prompt: "Has it been paid?" },
    urgency: { type: "score", prompt: "How urgent?", levels: [{ id: "low", description: "low" }, { id: "mid", description: "mid" }, { id: "high", description: "high" }] },
    language: { type: "choice", prompt: "Which language?", options: [{ id: "en", description: "English" }, { id: "de", description: "German" }] },
  },
}
const RULES = { noul: { accept: 0.85 } }
const OPTIONS = {
  questionSets: { "document-kind-v1": SET },
  acceptanceProfiles: {
    "document-kind-auto-v1": {
      mode: "automatic",
      model: "typesafe/jev-1.14",
      questionSet: "document-kind-v1",
      rules: RULES,
      maxFalseAcceptRate: "0.02",
      report: {
        schemaVersion: 1,
        profile: "document-kind-auto-v1",
        model: "typesafe/jev-1.14",
        questionSet: "document-kind-v1",
        questionSetDigest: questionSetDigest(SET),
        adapterRevision: "openrouter-alpha-decisions-2026-11-11.1",
        thresholds: RULES,
        dataset: { revision: "r1", sha256: "b".repeat(64), tuning: 100, heldOut: 50 },
        heldOut: { answers: 200, accepted: 120, falseAccepts: 1, reviewed: 70, refused: 10 },
        createdAt: "2026-11-12T00:00:00Z",
      },
    },
  },
}
const fixture = {
  ...OPENROUTER_CAPABILITIES,
  revision: "host-test-decide-1",
  routes: OPENROUTER_CAPABILITIES.routes.map((route) =>
    route.model === "typesafe/jev-1.14"
      ? { ...route, enabled: true, effectiveContextTokens: 4096, contextAllowance: { tokens: 512, source: "host test" }, canary: { status: "passed" as const, on: "2026-11-12" }, pricing: { revision: "host-test", currency: "USD" as const, perRequest: "0.002", upperBound: true } }
      : route,
  ),
}

describe(`inference_decide on OpenCode ${HOST_VERSION} (embedded SDK), against a loopback fake provider`, () => {
  let host: Host
  let server: Server
  let sessionID: string
  const seen: { path: string; authorization: string | undefined; body: Record<string, any> }[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      request.on("end", () => {
        seen.push({ path: request.url ?? "", authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, any> })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(FIXTURE)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    host = await startHost({ options: OPTIONS as never, plugin: createPlugin({ packageRoot: REPO, fixture, transportOrigin: origin, stateRoot: join(root, "inference-state-decide") }) })
    sessionID = (await host.client.session.create({ agent: "build", location: host.location })).id
    await until("the observer has the location's context", async () => host.context?.() !== undefined)
    await host.client.integration.connect.key({ integrationID: "inference-openrouter", key: FAKE_KEY, label: "Host test", location: host.location })
  })
  afterAll(async () => {
    await host?.close()
    server?.close()
  })

  test("Code Mode and the tools RPC return the same answers and acceptance; the key goes only to the fake, in its header", async () => {
    const input = { profile: "decide-text", source: { kind: "text", text: STATE }, questionSet: "document-kind-v1", acceptanceProfile: "document-kind-auto-v1" }
    const viaScript = (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method: "decide", input: { sessionID, input } as never, location: host.location })).output as Record<string, any>
    const message = await (host.client as any).experimental.schedule
      .create({
        sessionID,
        location: host.location,
        name: "decide-check",
        when: { in: "6 hours" },
        if: { code: `const result = await tools.inference.decide(${JSON.stringify(input)})\nthrow new Error("SEEN " + JSON.stringify(result))` },
        prompt: "never wakes",
      })
      .then(() => "created", (error: Error) => error.message)
    const viaModel = JSON.parse(/SEEN (\{.*\})/s.exec(message)?.[1] ?? "null") as Record<string, any>
    expect(viaModel).not.toBeNull()
    for (const result of [viaScript, viaModel]) {
      expect(result.data.questionSet).toEqual({ name: "document-kind-v1", digest: questionSetDigest(SET) })
      expect(result.data.acceptanceProfile).toEqual({ name: "document-kind-auto-v1", mode: "automatic" })
      expect(result.data.answers.paid).toMatchObject({ probability: "0.12", acceptance: { disposition: "accepted", outcome: false } })
      expect(result.data.answers.kind).toMatchObject({ distribution: { invoice: "0.7", receipt: "0.2" }, acceptance: { disposition: "review" } })
      expect(result.data.answers.language.acceptance).toEqual({ disposition: "refused", reasons: ["REFUSED"] })
      expect(result.usage.charges).toEqual([{ party: "platform", currency: "USD", amount: "0.000042000001", basis: "reported" }])
    }
    expect(viaModel.data).toEqual(viaScript.data)
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.path).toBe("/api/alpha/decisions")
      expect(request.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(request.body).toMatchObject({ model: "typesafe/jev-1.14", state: STATE, provider: { allow_fallbacks: false } })
      expect(Object.keys(request.body.questions)).toEqual(["kind", "paid", "urgency", "language"])
    }
    expect(JSON.stringify([viaScript, viaModel])).not.toContain(FAKE_KEY)
  })
})
