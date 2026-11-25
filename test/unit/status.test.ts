import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { STATUS_SCHEMA, type AccountSignal } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { rulesFor } from "@we-the-rebel-alliance/plugin-contract/access"
import { commandStatus } from "../../src/commands.js"
import { loadConfig } from "../../src/domain/config.js"
import { createHandlers } from "../../src/handlers/index.js"
import { OPENROUTER_CAPABILITIES } from "../../src/provider/capabilities.js"
import type { ConnectionHost } from "../../src/accounts.js"
import type { HandlerDeps } from "../../src/handlers/deps.js"
import type { OperationRuntime } from "../../src/runtime/operation.js"
import { manifestOf } from "../support/manifest.js"

const schema = z.fromJSONSchema(STATUS_SCHEMA as never)

const connection = (state: "ready" | "needs_sign_in" | "error"): ConnectionHost => ({
  connection: {
    active: async (id: string) => {
      if (state === "needs_sign_in") return undefined
      if (state === "error") return { type: "credential", id: `cred_${id}`, label: id, method: "key", status: { type: "needs_auth" } } as never
      return { type: "credential", id: `cred_${id}`, label: id, method: "key" } as never
    },
  } as never,
})

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const manifest = manifestOf()
  return {
    manifest,
    version: "0.0.0",
    hostVersion: "2.4.1",
    config: loadConfig({}),
    fixture: OPENROUTER_CAPABILITIES,
    profiles: [
      { alias: "work", profile: {} },
      { alias: "personal", profile: {} },
    ],
    accountProblems: [],
    integration: connection("needs_sign_in"),
    operation: {} as OperationRuntime,
    ...overrides,
  }
}

const call = (unguardedAgents: () => Promise<{ ok: true; agents: readonly string[] } | { ok: false; error: string }> = async () => ({ ok: true, agents: [] })): MethodCall =>
  ({ account: "work", sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => undefined, door: "rpc", unguardedAgents }) as unknown as MethodCall

describe("status", () => {
  test("with two aliases and no sign-in, it is needs_sign_in and lists both in the options' order", async () => {
    const status = createHandlers(deps()).status!
    const answer = await status.run({}, call())
    expect(schema.safeParse(answer).success).toBe(true)
    expect(answer).toMatchObject({
      name: "inference",
      version: "0.0.0",
      host: { version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] },
      state: "needs_sign_in",
      accounts: [
        { alias: "work", state: "needs_sign_in" },
        { alias: "personal", state: "needs_sign_in" },
      ],
      unguardedAgents: [],
      nextStep: "Sign in to the account that needs it, then read status again.",
    })
  })

  test("a connected alias is ready, a rejected one is error, and no alias needs signing in makes the plugin ready", async () => {
    const ready = await createHandlers(deps({ integration: connection("ready") })).status!.run({}, call())
    expect(ready).toMatchObject({ state: "ready", nextStep: null, accounts: [{ alias: "work", state: "ready" }, { alias: "personal", state: "ready" }] })
    const rejected = await createHandlers(deps({ integration: connection("error") })).status!.run({}, call())
    expect(rejected).toMatchObject({ state: "error", accounts: [{ alias: "work", state: "error", reason: expect.any(String) }, { alias: "personal", state: "error", reason: expect.any(String) }] })
    expect((rejected as { nextStep: string }).nextStep.length).toBeLessThanOrEqual(160)
  })

  test("an unreadable agent list is unknown, never zero: the state is error and the next step is redacted", async () => {
    const status = createHandlers(deps({ integration: connection("ready") })).status!
    const answer = (await status.run({}, call(async () => ({ ok: false as const, error: "agents unavailable for ana@example.com?token=abc" })))) as {
      state: string
      unguardedAgents: string[]
      nextStep: string
    }
    expect(answer.state).toBe("error")
    expect(answer.unguardedAgents).toEqual([])
    expect(answer.nextStep).not.toContain("abc")
    expect(answer.nextStep.length).toBeLessThanOrEqual(160)
  })

  test("the command wrapper turns a rejected agent list into a status problem, never zero", async () => {
    const status = createHandlers(deps({ integration: connection("ready") })).status!
    const rules = rulesFor(deps().manifest, "all", ["work", "personal"])
    const failed = await commandStatus(status, async () => Promise.reject(new Error("agents unavailable for ana@example.com?token=abc")), rules)
    expect(failed.state).toBe("error")
    expect(failed.unguardedAgents).toEqual([])
    expect(failed.nextStep).not.toContain("abc")
    const listed = await commandStatus(status, async () => ({ data: [{ id: "reviewer", permissions: [] }] }), rules)
    expect(listed.unguardedAgents).toEqual(["reviewer"])
  })

  test("unguarded agents and registration problems are reported, and a plugin with no accounts lists none", async () => {
    const withAgents = (await createHandlers(deps({ integration: connection("ready") })).status!.run({}, call(async () => ({ ok: true as const, agents: ["reviewer"] })))) as { unguardedAgents: string[] }
    expect(withAgents.unguardedAgents).toEqual(["reviewer"])
    const problems = (await createHandlers(deps({ integration: connection("ready"), accountProblems: ["accounts.work: the integration could not be registered"] })).status!.run({}, call())) as {
      state: string
      nextStep: string
    }
    expect(problems.state).toBe("error")
    expect(problems.nextStep).toContain("accounts.work")
    const none = (await createHandlers(deps({ profiles: [] })).status!.run({}, call())) as { accounts: unknown[]; state: string }
    expect(none.accounts).toEqual([])
  })
})
