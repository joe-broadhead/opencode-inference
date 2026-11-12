// Setup, cleanup, failure cleanup, reload and the "no network from local surfaces" gate, on a narrow fake context.
// The real host runs the same in test/host.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { createPlugin } from "../../src/host/plugin.js"
import { defaultRules } from "../../src/host/permissions.js"
import { PLUGIN_ID } from "../../src/domain/ids.js"
import { fakeContext } from "../support/fake-context.js"
import { spyNetwork } from "../support/network-spy.js"

const packageRoot = fileURLToPath(new URL("../../", import.meta.url))
const NOW = () => new Date("2026-11-12T00:00:00Z")
const plugin = () => createPlugin({ packageRoot, now: NOW })
const text = { kind: "text", text: "Invoice AB-72. Total EUR 120.00." }
const toolCall = (signal = new AbortController().signal) => ({ sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal, progress: async () => undefined })

let network: ReturnType<typeof spyNetwork>
beforeEach(() => (network = spyNetwork()))
afterEach(() => network.restore())

describe("setup", () => {
  test("registers the integration, rules, tools, both RPCs, the RPC's ask hook and the command, and nothing touches the network", async () => {
    const fake = fakeContext({ sessions: { ses_1: { agent: "build" } } })
    const cleanup = await plugin().setup(fake.context)
    expect(fake.live().map((item) => item.kind)).toEqual(["integration", "agent", "tool", `rpc:${PLUGIN_ID}`, `rpc:${TOOLS_RPC_ID}`, "hook:evaluate", "command"])
    expect(fake.integrations.get("inference-openrouter")).toEqual({ id: "inference-openrouter", name: "OpenRouter for Inference" })
    expect(fake.methods).toEqual([{ integrationID: "inference-openrouter", method: { type: "key", label: "OpenRouter API key" } }])
    expect(fake.tools.map((tool) => tool.name)).toEqual(["status", "capabilities", "plan", "extract"])
    expect(fake.commands.map((command) => command.name)).toEqual(["inference-status"])
    // Every local surface, on both paths.
    for (const tool of fake.tools.filter((item) => item.name !== "extract")) {
      const input = tool.name === "plan" ? { task: "extract", input: { source: text, profile: "extract-typed", fields: { total: { type: "number" } } } } : {}
      const result = await tool.execute(input, toolCall())
      expect(result.output).toBeDefined()
      const scripted = (await fake.call(TOOLS_RPC_ID, tool.name, { sessionID: "ses_1", input })) as Record<string, unknown>
      expect(scripted.error).toBeUndefined()
    }
    // extract is registered, but every route is disabled: it says so on both paths, before reading the key or sending.
    const extract = { source: text, profile: "extract-typed", fields: { total: { type: "number" } } }
    const refused = await fake.tools.find((tool) => tool.name === "extract")!.execute(extract, toolCall()).then(() => undefined, (error: Error) => error)
    expect(refused?.message).toMatch(/^CAPABILITY_UNSUPPORTED: cloudflare\/clairic is disabled in this version: its route waits for a compatibility canary/)
    expect(((await fake.call(TOOLS_RPC_ID, "extract", { sessionID: "ses_1", input: extract })) as { error: { data: { code: string } } }).error.data.code).toBe("CAPABILITY_UNSUPPORTED")
    await fake.call(PLUGIN_ID, "status", {})
    await fake.call(TOOLS_RPC_ID, "describe", {})
    await fake.commands[0]!.execute({ sessionID: "ses_1", delivery: "now" })
    expect(fake.synthetic[0]!.text).toStartWith("Inference status\nConnection: not connected")
    expect(network.calls).toEqual([])
    // The key is never read in this version.
    expect(fake.resolved).toEqual([])
    await (cleanup as () => Promise<void>)()
    expect(fake.live()).toEqual([])
    expect(network.calls).toEqual([])
  })

  test("a connected key is reported as connected, and still never read", async () => {
    const fake = fakeContext({ connection: { type: "credential" } })
    const cleanup = (await plugin().setup(fake.context)) as () => Promise<void>
    const status = (await fake.call(PLUGIN_ID, "status", {})) as { connection: unknown; state: string; nextStep: string }
    expect(status.connection).toEqual({ integration: "inference-openrouter", state: "connected", required: false })
    expect(status.state).toBe("local_only")
    expect(status.nextStep).toBe("Nothing to do.")
    expect(JSON.stringify(status)).not.toContain("sk-or-fake")
    expect(fake.resolved).toEqual([])
    await cleanup()
  })

  test("invalid options fail setup before anything is registered", async () => {
    const fake = fakeContext({ options: { apiKey: "sk-or-secret" } })
    await expect(plugin().setup(fake.context)).rejects.toThrow(/^OPTIONS_INVALID:/)
    expect(fake.registrations).toEqual([])
  })

  test("a host outside the range refuses, unless allowUntestedHost is set", async () => {
    await expect(plugin().setup(fakeContext({ version: "2.3.0" }).context)).rejects.toThrow(/^HOST_UNTESTED:/)
    const fake = fakeContext({ version: "2.3.0", options: { allowUntestedHost: true } })
    const warn = console.warn
    console.warn = () => undefined
    try {
      const cleanup = (await plugin().setup(fake.context)) as () => Promise<void>
      const status = (await fake.call(PLUGIN_ID, "status", {})) as { host: { tested: boolean; next?: string }; nextStep: string }
      expect(status.host.tested).toBe(false)
      expect(status.nextStep).toBe(status.host.next!)
      await cleanup()
    } finally {
      console.warn = warn
    }
  })
})

describe("failure cleanup", () => {
  // Registration 1 (the integration) is optional and reported in status; every later one fails setup.
  for (let failAt = 2; failAt <= 7; failAt++)
    test(`a failure at registration ${failAt} disposes everything registered before it`, async () => {
      const fake = fakeContext({ failAt })
      await expect(plugin().setup(fake.context)).rejects.toThrow(/fake registration/)
      expect(fake.registrations.length).toBe(failAt - 1)
      expect(fake.live()).toEqual([])
    })

  test("a failure to add the /connect entry is a status problem, not a setup failure", async () => {
    const fake = fakeContext({ failAt: 1 })
    const cleanup = (await plugin().setup(fake.context)) as () => Promise<void>
    const status = (await fake.call(PLUGIN_ID, "status", {})) as { problems: string[]; nextStep: string }
    expect(status.problems).toEqual(["INTEGRATION_NOT_REGISTERED: The OpenRouter key entry could not be added to /connect. Next step: Restart OpenCode."])
    expect(status.nextStep).toBe(status.problems[0]!)
    await cleanup()
    expect(fake.live()).toEqual([])
  })
})

describe("reload", () => {
  test("setup, cleanup and setup again leave one set of registrations, one block per agent, and no timers or handles", async () => {
    const before = process.getActiveResourcesInfo().filter((kind) => kind !== "TTYWrap").length
    const fake = fakeContext({ options: { access: "ask-changes" } })
    const first = (await plugin().setup(fake.context)) as () => Promise<void>
    await first()
    expect(fake.live()).toEqual([])
    const second = (await plugin().setup(fake.context)) as () => Promise<void>
    expect(fake.live().length).toBe(7)
    // The agents are the same objects across both setups, and the transform is replayed: still exactly one block.
    fake.replayAgents()
    const block = JSON.stringify(defaultRules("ask-changes"))
    for (const agent of fake.agents.filter((item) => item.id !== "locked")) {
      const text = JSON.stringify(agent.permissions)
      expect(text.split(block.slice(1, -1)).length - 1).toBe(1)
    }
    expect(fake.agents.find((item) => item.id === "locked")!.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    await second()
    expect(fake.live()).toEqual([])
    expect(process.getActiveResourcesInfo().filter((kind) => kind !== "TTYWrap").length).toBeLessThanOrEqual(before)
  })

  test("a call after cleanup is refused by the dispatcher on both paths", async () => {
    const fake = fakeContext({ sessions: { ses_1: { agent: "build" } } })
    const cleanup = (await plugin().setup(fake.context)) as () => Promise<void>
    const status = fake.tools.find((tool) => tool.name === "status")!
    const rpc = fake.rpc.get(TOOLS_RPC_ID)!.handlers
    await cleanup()
    await expect(status.execute({}, toolCall())).rejects.toThrow(/CLOSED/)
    const scripted = (await rpc.status!({ sessionID: "ses_1", input: {} }, { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ error: { type, message, data } }) })) as { error: { data: { code: string } } }
    expect(scripted.error.data.code).toBe("CLOSED")
  })
})
