// The conformance recording: the two synthetic accounts the kit replays, the status answer and account nudge the
// plugin's own handlers produce, and the inputs the RPC door refuses without a confirmation. T0 and T1 are the kit's:
// `npx plugin-kit check` runs them on the real 2.4.1 host and on an unsupported one.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { createHost } from "@we-the-rebel-alliance/plugin-contract/kit"
import { loadConfig } from "../../src/domain/config.js"
import { DecideInput, ExtractInput } from "../../src/domain/contracts.js"
import { createHandlers } from "../../src/handlers/index.js"
import type { HandlerDeps } from "../../src/handlers/deps.js"
import { OPENROUTER_CAPABILITIES } from "../../src/provider/capabilities.js"
import type { ConnectionHost } from "../../src/accounts.js"
import type { OperationRuntime } from "../../src/runtime/operation.js"
import { manifestOf, packageOf } from "../support/manifest.js"

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/conformance.json", import.meta.url), "utf8")) as Record<string, any>
const manifest = manifestOf()
const { version } = packageOf()
const ROOT = new URL("../../", import.meta.url).pathname

const unconnected: ConnectionHost = { connection: { active: async () => undefined } as never }

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    manifest,
    version,
    hostVersion: "2.4.1",
    config: loadConfig({ accounts: { work: {}, personal: {} } }),
    fixture: OPENROUTER_CAPABILITIES,
    profiles: [
      { alias: "work", profile: {} },
      { alias: "personal", profile: {} },
    ],
    accountProblems: [],
    integration: unconnected,
    operation: {} as OperationRuntime,
    ...overrides,
  }
}

describe("the recording", () => {
  test("names this package, the two aliases, and its registered namespace", () => {
    expect(fixture["plugin"]).toBe("@we-the-rebel-alliance/inference-plugin")
    expect(fixture["accounts"]["aliases"]).toEqual(["work", "personal"])
    expect(fixture["namespace"]).toBe(manifest.plugin.summary)
    expect(fixture["accounts"]["required"]).toEqual({ method: "probe", code: "ACCOUNT_REQUIRED" })
    expect(fixture["accounts"]["unknown"]).toEqual({ method: "probe", account: "nobodyhere", code: "ACCOUNT_UNKNOWN" })
  })

  test("every recorded RPC input is a valid input for its method", () => {
    expect(ExtractInput.safeParse(fixture["rpc"]["inputs"]["extract"]).success).toBe(true)
    expect(DecideInput.safeParse(fixture["rpc"]["inputs"]["decide"]).success).toBe(true)
  })
})

describe("the recorded status", () => {
  test("is what the status handler answers with two aliases and neither signed in", async () => {
    const answer = await createHandlers(deps()).status!.run({}, { unguardedAgents: async () => [] } as unknown as MethodCall)
    expect(answer).toEqual(fixture["events"]["status"])
  })
})

describe("the recorded account nudge", () => {
  test("probe emits account/needs_sign_in, then refuses with NEEDS_SIGN_IN", async () => {
    const emitted: unknown[] = []
    const bus = { name: "inference", emit: async (event: string, data: unknown) => (emitted.push({ event, data }), { ok: true }) } as never
    const call = { account: "work", bus, unguardedAgents: async () => [] } as unknown as MethodCall
    const probe = createHandlers(deps()).probe!
    await expect(probe.run({}, call)).rejects.toThrow(/^NEEDS_SIGN_IN:/)
    expect(emitted).toEqual([{ event: "account", data: { account: "work", state: "needs_sign_in" } }])
    expect(fixture["events"]["emitted"]).toEqual(["account"])
  })
})

describe("two accounts on the real host", () => {
  test("a missing account is ACCOUNT_REQUIRED, an unknown one is ACCOUNT_UNKNOWN, and a known one needs its sign-in", async () => {
    const run = await createHost({ directory: ROOT, version: "2.4.1", pluginId: "inference", options: { access: "all", accounts: { work: {}, personal: {} } } })
    try {
      expect(run.failure).toBeUndefined()
      expect(run.refusal).toBeUndefined()
      const missing = await run.call("probe", {})
      expect(missing.ok ? undefined : missing.code).toBe("ACCOUNT_REQUIRED")
      const unknown = await run.call("probe", { account: "nobodyhere" })
      expect(unknown.ok ? undefined : unknown.code).toBe("ACCOUNT_UNKNOWN")
      const known = await run.call("probe", { account: "work" })
      expect(known.ok).toBe(false)
      expect(known.ok === false ? known.code : undefined).toBe("NEEDS_SIGN_IN")
    } finally {
      await run.close()
    }
  })
})
