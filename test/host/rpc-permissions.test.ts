// The tools RPC's own-action gate on the embedded OpenCode host, with nobody present to answer a prompt: at
// `access: "ask-changes"` and `access: "read-only"`, a script's extract and decide calls are refused by the tools RPC
// before the dispatcher runs, so no prompt is created, no route is resolved, no reservation or journal entry is written
// and nothing reaches the network transport. The allow-override sessions are controls: the same calls reach the
// dispatcher and stop at the missing key, or fail at strict input parsing or route resolution, which is what proves the
// refused calls never got that far. The fixture enables both routes; the loopback server is a sentinel that must see
// nothing. No key is connected and no network is used.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { WIRE_REVISION as EXTRACTIONS_REVISION } from "../../src/providers/openrouter/extractions.js"
import { WIRE_REVISION as DECISIONS_REVISION } from "../../src/providers/openrouter/decisions.js"
import { createPlugin } from "../../src/host/plugin.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { cleanup, HOST_VERSION, REPO, root, startHost, type Host } from "./harness.js"

setDefaultTimeout(300_000)
afterAll(cleanup)

const STATE = "Payment received for invoice AB-72. Thank you."
const FIELDS = { invoice_id: { type: "text" }, total: { type: "number", decimals: 2 } }
const QUESTIONS = { kind: { type: "choice", prompt: "Which document category fits?", options: [{ id: "invoice", description: "A request for payment" }, { id: "receipt", description: "Proof of payment" }] } }
const extractInput = { profile: "extract-typed", source: { kind: "text", text: STATE }, fields: FIELDS }
const decideInput = { profile: "decide-text", source: { kind: "text", text: STATE }, questions: QUESTIONS }

/** The reviewed fixture with both routes enabled and priced, so a call that reached the dispatcher would go on. */
const fixture = {
  ...OPENROUTER_CAPABILITIES,
  revision: "host-test-rpc-permissions-1",
  routes: OPENROUTER_CAPABILITIES.routes.map((route) => {
    if (route.model === "cloudflare/clairic")
      return {
        ...route,
        enabled: true,
        canary: { status: "passed" as const, on: "2026-11-12", reports: { request: "extractions-20261112T000000Z.json", malformed: "extractions-20261112T000001Z.json" }, wireRevision: EXTRACTIONS_REVISION },
        pricing: { revision: "host-test", currency: "USD" as const, perRequest: "0.004", upperBound: true },
      }
    if (route.model === "typesafe/jev-1.14")
      return {
        ...route,
        enabled: true,
        effectiveContextTokens: 4096,
        contextAllowance: { tokens: 512, source: "host test" },
        canary: { status: "passed" as const, on: "2026-11-12", reports: { request: "decisions-20261112T000000Z.json", malformed: "decisions-20261112T000001Z.json" }, wireRevision: DECISIONS_REVISION },
        pricing: { revision: "host-test", currency: "USD" as const, perRequest: "0.002", upperBound: true },
      }
    return route
  }),
}

type Result = { value?: Record<string, any>; type?: string; code?: string; message?: string }

async function script(host: Host, sessionID: string, method: string, input: unknown): Promise<Result> {
  try {
    return { value: (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method, input: { sessionID, input } as never, location: host.location })).output as Record<string, any> }
  } catch (error) {
    const failure = error as Record<string, any>
    return { type: failure.type ?? failure._tag, code: failure.data?.code, message: String(failure.message ?? failure) }
  }
}

/** The input reached only when the route would be resolved: an explicit model no reviewed route names. */
const withUnknownRoute = (input: { profile?: string }) => {
  const { profile: _profile, ...rest } = input
  return { ...rest, model: "test/not-a-reviewed-route" }
}

/** A digest of every file under the plugin state folder, so a refusal can prove it wrote nothing. */
function stateTree(directory: string): string {
  if (!existsSync(directory)) return "absent"
  const lines: string[] = []
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, relative)
      else if (entry.isFile()) lines.push(`${relative} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`)
      else lines.push(`${relative} other`)
    }
  }
  walk(directory, "")
  return lines.join("\n")
}

interface AccessHost {
  readonly host: Host
  readonly state: string
  readonly build: string
  readonly allow: string
}

describe(`the tools RPC's own action on OpenCode ${HOST_VERSION} (embedded SDK), unattended`, () => {
  let server: Server
  let origin: string
  let ask: AccessHost
  let deny: AccessHost
  const seen: { path: string; authorization: string | undefined; body: string }[] = []

  async function accessHost(access: "ask-changes" | "read-only"): Promise<AccessHost> {
    const state = join(root, `inference-state-rpc-permissions-${access}`)
    const host = await startHost({ options: { access }, plugin: createPlugin({ packageRoot: REPO, fixture, transportOrigin: origin, stateRoot: state }) })
    const allow = [
      { action: "inference_extract", resource: "*", effect: "allow" as const },
      { action: "inference_decide", resource: "*", effect: "allow" as const },
    ]
    const create = async (permissions?: typeof allow) =>
      (await host.client.session.create({ agent: "build", location: host.location, ...(permissions ? { permissions } : {}) } as never)).id
    return { host, state, build: await create(), allow: await create(allow) }
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      request.on("end", () => {
        seen.push({ path: request.url ?? "", authorization: request.headers.authorization, body })
        response.writeHead(500, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "sentinel" }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    ask = await accessHost("ask-changes")
    deny = await accessHost("read-only")
  })
  afterAll(async () => {
    await ask?.host.close()
    await deny?.host.close()
    server?.close()
  })

  test("access ask-changes: extract and decide are refused unattended with no prompt, dispatch, route, journal or transport", async () => {
    const pending = async (host: Host) => (await host.client.permission.request.list({ location: host.location })).data
    expect(await pending(ask.host)).toEqual([])

    // Controls: the allow override reaches the dispatcher and route, and these calls stop only for a different reason.
    // Without them, a refusal that never ran anything would look the same as a refusal that ran halfway.
    expect(await script(ask.host, ask.allow, "extract", extractInput)).toMatchObject({ type: "failed", code: "AUTH_REQUIRED" })
    expect(await script(ask.host, ask.allow, "decide", decideInput)).toMatchObject({ type: "failed", code: "AUTH_REQUIRED" })
    expect(await script(ask.host, ask.allow, "extract", {})).toMatchObject({ type: "failed", code: "INPUT_INVALID" })
    expect(await script(ask.host, ask.allow, "decide", {})).toMatchObject({ type: "failed", code: "INPUT_INVALID" })
    expect(await script(ask.host, ask.allow, "extract", withUnknownRoute(extractInput))).toMatchObject({ type: "failed", code: "CAPABILITY_UNSUPPORTED" })
    expect(await script(ask.host, ask.allow, "decide", withUnknownRoute(decideInput))).toMatchObject({ type: "failed", code: "CAPABILITY_UNSUPPORTED" })

    const seenBefore = seen.length
    const stateBefore = stateTree(ask.state)
    // The loopback sentinel saw nothing, even from the controls.
    expect(seenBefore).toBe(0)
    // The journal is the only place a reservation is persisted: no journal, no reservation.
    expect(stateBefore).toBe("absent")
    for (const [method, input] of [["extract", extractInput], ["decide", decideInput], ["extract", {}], ["decide", {}], ["extract", withUnknownRoute(extractInput)], ["decide", withUnknownRoute(decideInput)]] as const) {
      const refused = await script(ask.host, ask.build, method, input)
      expect(refused).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(refused.message).toContain(`inference_${method} would ask for this session's agent, and a script cannot answer`)
    }
    expect(await pending(ask.host)).toEqual([])
    expect(seen).toHaveLength(seenBefore)
    expect(stateTree(ask.state)).toBe(stateBefore)
  })

  test("access read-only: extract and decide are denied unattended with no prompt, dispatch, route, journal or transport", async () => {
    const pending = async (host: Host) => (await host.client.permission.request.list({ location: host.location })).data
    expect(await pending(deny.host)).toEqual([])

    expect(await script(deny.host, deny.allow, "extract", extractInput)).toMatchObject({ type: "failed", code: "AUTH_REQUIRED" })
    expect(await script(deny.host, deny.allow, "decide", decideInput)).toMatchObject({ type: "failed", code: "AUTH_REQUIRED" })
    expect(await script(deny.host, deny.allow, "extract", {})).toMatchObject({ type: "failed", code: "INPUT_INVALID" })
    expect(await script(deny.host, deny.allow, "decide", {})).toMatchObject({ type: "failed", code: "INPUT_INVALID" })
    expect(await script(deny.host, deny.allow, "extract", withUnknownRoute(extractInput))).toMatchObject({ type: "failed", code: "CAPABILITY_UNSUPPORTED" })
    expect(await script(deny.host, deny.allow, "decide", withUnknownRoute(decideInput))).toMatchObject({ type: "failed", code: "CAPABILITY_UNSUPPORTED" })

    const seenBefore = seen.length
    const stateBefore = stateTree(deny.state)
    // The loopback sentinel saw nothing, even from the controls.
    expect(seenBefore).toBe(0)
    // The journal is the only place a reservation is persisted: no journal, no reservation.
    expect(stateBefore).toBe("absent")
    for (const [method, input] of [["extract", extractInput], ["decide", decideInput], ["extract", {}], ["decide", {}], ["extract", withUnknownRoute(extractInput)], ["decide", withUnknownRoute(decideInput)]] as const) {
      const refused = await script(deny.host, deny.build, method, input)
      expect(refused).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      expect(refused.message).toContain(`inference_${method} is hidden from this session's agent by a deny rule`)
    }
    expect(await pending(deny.host)).toEqual([])
    expect(seen).toHaveLength(seenBefore)
    expect(stateTree(deny.state)).toBe(stateBefore)
  })
})
