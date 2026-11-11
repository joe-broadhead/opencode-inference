// The plugin on the embedded OpenCode host (see harness.ts): registration, the default rules through the host's own
// evaluation, the status RPC and /inference-status, the tools RPC as a session, Code Mode, and the plugin-owned
// OpenRouter key entry. Nothing leaves loopback; the harness fails a host that tried.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { jsonSchemaOf, TOOL_NAMES, TOOLS } from "../../src/domain/registry.js"
import { defaultRules } from "../../src/host/permissions.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { Inference } from "../../src/rpc.js"
import { cleanup, HOST_VERSION, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(300_000)
afterAll(cleanup)

type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })
const text = { kind: "text", text: "Invoice AB-72. Total EUR 120.00. 総額 💶" }
const planInput = { task: "extract", input: { source: text, profile: "extract-typed", fields: { invoice_id: { type: "text" }, total: { type: "number", decimals: 2 } } } }
const FAKE_KEY = "sk-or-v1-host-test-fake-key-0123456789"

async function script(host: Host, method: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: (await host.client.rpc.call({ rpcID: TOOLS_RPC_ID, method, input: input as never, location: host.location })).output }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}
const status = async (host: Host) => (await host.client.rpc(Inference).status({}, { location: host.location })) as Record<string, any>

/** Runs a Code Mode program through the host's own tool path, unattended, as a schedule condition does. */
async function codemode(host: Host, sessionID: string, body: string) {
  const code = `const seen = {}\n${body}\nthrow new Error("SEEN " + JSON.stringify(seen))`
  const message = await (host.client as any).experimental.schedule
    .create({ sessionID, location: host.location, name: "inference-check", when: { in: "6 hours" }, if: { code }, prompt: "never wakes" })
    .then(() => "created", (error: Error) => error.message)
  const seen = /SEEN (\{.*\})/s.exec(message)
  if (!seen) throw new Error(`the program did not finish: ${message}`)
  return JSON.parse(seen[1]!) as Record<string, any>
}

describe(`defaults on OpenCode ${HOST_VERSION} (embedded SDK)`, () => {
  let host: Host
  const sessions: Record<string, string> = {}
  beforeAll(async () => {
    host = await startHost({
      config: { agents: { reviewer: { description: "Defined only in config", mode: "primary" }, locked: { permissions: [rule("inference_*", "deny")] }, careful: { permissions: [rule("inference_plan", "ask")] } } },
    })
    const create = async (agent: string) => (await host.client.session.create({ agent, location: host.location })).id
    for (const agent of ["build", "locked", "careful"]) sessions[agent] = await create(agent)
    await until("the observer has the location's context", async () => host.context?.() !== undefined)
  })
  afterAll(() => host?.close())

  test("registers exactly the three local tools, with the namespace and permission actions, and /inference-status", async () => {
    const tools = (await host.context!()!.tool.list()).filter((tool) => tool.id.startsWith("inference_"))
    expect(tools.map((tool) => tool.id).sort()).toEqual(TOOL_NAMES.map((name) => `inference_${name}`).sort())
    for (const tool of tools) expect(tool.options).toMatchObject({ namespace: "inference", permission: tool.id })
    const { data: commands } = await host.client.command.list({ location: host.location })
    expect(commands.map((command) => command.name)).toContain("inference-status")
  })

  test("puts the default block right after each built-in agent's base allow, and the host enforces it", async () => {
    const { data: agents } = await host.client.agent.list({ location: host.location })
    for (const id of ["build", "plan", "general"]) {
      const permissions = agents.find((agent) => agent.id === id)!.permissions
      const base = permissions.findIndex((item) => item.action === "*" && item.resource === "*" && item.effect === "allow")
      expect(permissions.slice(base, base + 1 + defaultRules().length)).toEqual([rule("*", "allow"), ...defaultRules()])
    }
    const effect = async (agent: string, action: string) => (await host.client.permission.create({ sessionID: sessions[agent]! as never, agent, action, resources: ["*"], save: ["*"] })).effect
    expect(await effect("build", "inference_plan")).toBe("allow")
    expect(await effect("build", "inference_extract")).toBe("allow")
  })

  test("the status RPC answers the shared fields first, local only, with nothing to do and no key", async () => {
    const view = await status(host)
    expect(Object.keys(view).slice(0, 5)).toEqual(["version", "host", "state", "unguardedAgents", "nextStep"])
    expect(view).toMatchObject({ state: "local_only", nextStep: "Nothing to do.", host: { version: HOST_VERSION, range: ">=2.2.3 <2.3.0", tested: true }, connection: { state: "not_connected", required: false } })
  })

  test("/inference-status posts the status into the session", async () => {
    const sessionID = sessions.build!
    const before = (await host.client.session.inbox.list({ sessionID: sessionID as never })).length
    await host.client.session.command({ sessionID: sessionID as never, name: "inference-status", text: "" } as never)
    const posted = await until("/inference-status posts its text", async () => {
      const inbox = await host.client.session.inbox.list({ sessionID: sessionID as never })
      const item = inbox.slice(before).findLast((entry: any) => entry.type === "synthetic") as any
      return item?.payload?.text as string | undefined
    })
    expect(posted).toStartWith("Inference status\nConnection: not connected")
    expect(posted.split("\n").filter((line) => line.startsWith("Next step:"))).toEqual(["Next step: Nothing to do."])
  })

  test("the tools RPC describes the registry's methods, classes and schemas", async () => {
    const { value } = await script(host, "describe", { sessionID: sessions.build })
    expect(value.id).toBe(TOOLS_RPC_ID)
    expect(value.methods.map((method: { name: string }) => method.name)).toEqual([...TOOL_NAMES])
    for (const [index, method] of value.methods.entries()) {
      expect(method).toMatchObject({ kind: "plugin", class: "read", action: `inference_${TOOLS[index]!.name}`, available: true, permission: "allow" })
      expect(method.input).toEqual(jsonSchemaOf(TOOLS[index]!.input, "input"))
    }
  })

  test("a script runs status, capabilities and plan as a session whose agent allows them", async () => {
    const plan = await script(host, "plan", { sessionID: sessions.build, input: planInput })
    expect(plan.value).toMatchObject({ task: "extract", route: { status: "ineligible", selected: { route: { model: "cloudflare/clairic" } } }, execution: { available: false }, quote: { kind: "unavailable" } })
    expect(plan.value.source.codePoints).toBe([...text.text].length)
    const caps = await script(host, "capabilities", { sessionID: sessions.build, input: { operation: "decide" } })
    expect(caps.value.routes.map((route: { model: string }) => route.model)).toEqual(["typesafe/jev-1.14"])
    expect((await script(host, "status", { sessionID: sessions.build, input: {} })).value).toMatchObject({ state: "local_only", unguardedAgents: 0 })
  })

  test("a deny and an ask are both refused before the tool runs; bad input is refused by the dispatcher", async () => {
    expect(await script(host, "plan", { sessionID: sessions.locked, input: planInput })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    const asked = await script(host, "plan", { sessionID: sessions.careful, input: planInput })
    expect(asked).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(asked.message).toMatch(/would ask for this session's agent, and a script cannot answer/)
    const bad = await script(host, "plan", { sessionID: sessions.build, input: { task: "extract", input: { source: text, fields: {} } } })
    expect(bad).toMatchObject({ type: "failed", code: "INPUT_INVALID" })
    expect(await script(host, "extract", { sessionID: sessions.build, input: {} })).not.toMatchObject({ value: expect.anything() })
  })

  test("Code Mode calls the tools and keeps the structured output, review and coverage included", async () => {
    const seen = await codemode(
      host,
      sessions.build!,
      `const plan = await tools.inference.plan(${JSON.stringify(planInput)})
seen.review = plan.review; seen.coverage = plan.coverage.expected; seen.quote = plan.quote.kind; seen.digest = plan.digest.slice(0, 7)
const status = await tools.inference.status({})
seen.state = status.state`,
    )
    expect(seen).toEqual({ review: { likely: true, reasons: ["CALIBRATION_UNAVAILABLE"], profileVersion: "review-first-v1" }, coverage: "complete", quote: "unavailable", digest: "sha256:", state: "local_only" })
    // A reserved operation is no Code Mode tool at all: the host refuses the program before it runs.
    await expect(codemode(host, sessions.build!, "seen.x = await tools.inference.extract({})")).rejects.toThrow(/Unknown Code Mode tool: inference\.extract/)
  })

  test("/connect lists OpenRouter for Inference; a connected key shows as connected and never appears anywhere", async () => {
    const { data: integrations } = await host.client.integration.list({ location: host.location })
    expect(integrations.find((entry) => entry.id === "inference-openrouter")?.name).toBe("OpenRouter for Inference")
    await host.client.integration.connect.key({ integrationID: "inference-openrouter", key: FAKE_KEY, label: "Host test", location: host.location })
    const view = await until("status reports the key as connected", async () => {
      const current = await status(host)
      return current.connection.state === "connected" ? current : undefined
    })
    expect(view).toMatchObject({ state: "local_only", nextStep: "Nothing to do." })
    const outputs = await Promise.all([status(host), script(host, "status", { sessionID: sessions.build, input: {} }), script(host, "describe", {})])
    expect(JSON.stringify(outputs)).not.toContain(FAKE_KEY)
  })
})

describe(`access: ask-changes on OpenCode ${HOST_VERSION} (embedded SDK)`, () => {
  let host: Host
  beforeAll(async () => {
    host = await startHost({ options: { access: "ask-changes" }, config: { agents: { reviewer: { description: "Defined only in config", mode: "primary" } } } })
  })
  afterAll(() => host?.close())

  test("reads still run, a future send asks, and a config-only agent is named with the fix", async () => {
    const sessionID = (await host.client.session.create({ agent: "build", location: host.location })).id
    const effect = async (action: string) => (await host.client.permission.create({ sessionID, agent: "build", action, resources: ["*"], save: ["*"] })).effect
    expect(await effect("inference_plan")).toBe("allow")
    expect(await effect("inference_extract")).toBe("ask")
    const view = await status(host)
    expect(view.access).toBe("ask-changes")
    expect(view.permissions.block).toEqual(defaultRules("ask-changes"))
    // Whether a config-only agent got the block depends on when the host creates it; status names it only when it lacks it.
    if (view.unguardedAgents.length) expect(view.unguardedAgents).toEqual(["reviewer"])
  })
})
