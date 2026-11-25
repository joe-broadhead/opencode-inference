// The built plugin in the real embedded OpenCode 2.4.1 host: its id, namespace, tools, RPC, events, access rules, and
// the reads an app can call without a confirmation. The kit's T1 runs the same host and checks the doors, the access
// matrix, the RPC confirmation and an unsupported host; this suite proves the product behaviour on top.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createHost, type HostRun } from "@we-the-rebel-alliance/plugin-contract/kit"
import { evaluate, effectFor } from "@we-the-rebel-alliance/plugin-contract/access"
import { manifestOf } from "../support/manifest.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const manifest = manifestOf()
const OPTIONS = { access: "all", accounts: { work: {}, personal: {} } }

let run: HostRun
beforeAll(async () => {
  run = await createHost({ directory: ROOT, version: "2.4.1", pluginId: manifest.plugin.name, options: OPTIONS })
})
afterAll(() => run?.close())

describe("the plugin on OpenCode 2.4.1", () => {
  test("loads with its one name and the manifest's namespace line", () => {
    expect(run.failure).toBeUndefined()
    expect(run.refusal).toBeUndefined()
    expect(run.definition?.id).toBe("inference")
    expect(run.namespace).toEqual({ name: "inference", description: manifest.plugin.summary })
  })

  test("registers every declared method as a tool in Code Mode and an RPC method, with its permission", () => {
    const methods = Object.keys(manifest.methods).sort()
    expect(run.tools.map((tool) => tool.permission).sort()).toEqual(methods.map((method) => `inference.${method}`))
    for (const tool of run.tools) {
      expect(tool.namespace).toBe("inference")
      expect(tool.codemode).toBe(true)
    }
    expect(run.rpc?.id).toBe("inference")
    expect([...(run.rpc?.methods ?? [])].sort()).toEqual(methods)
    expect(run.rpc?.events).toEqual(["account"])
  })

  test("generates the access rules into every agent: reads always, sends follow the level", () => {
    const build = run.agents.find((agent) => agent.id === "build")
    expect(build).toBeDefined()
    for (const method of ["status", "probe", "capabilities", "plan"]) expect(evaluate(build!.permissions, `inference.${method}`, "*")).toBe("allow")
    expect(evaluate(build!.permissions, "inference.extract", "*")).toBe(effectFor(manifest.methods["extract"]!, "all"))
    expect(evaluate(build!.permissions, "inference.decide", "*")).toBe(effectFor(manifest.methods["decide"]!, "all"))
  })

  test("status answers the contract shape with both aliases and no sign-in", async () => {
    const answer = await run.call("status", {})
    expect(answer.ok).toBe(true)
    expect(answer.ok && answer.output).toMatchObject({
      name: "inference",
      version: "0.0.0",
      host: { version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] },
      state: "needs_sign_in",
      accounts: [
        { alias: "work", state: "needs_sign_in" },
        { alias: "personal", state: "needs_sign_in" },
      ],
      unguardedAgents: [],
    })
  })

  test("capabilities lists the three operations and the reviewed routes", async () => {
    const answer = await run.call("capabilities", {})
    expect(answer.ok).toBe(true)
    const output = answer.ok ? (answer.output as { operations: { name: string; implemented: boolean }[]; routes: unknown[] }) : undefined
    expect(output?.operations.map((operation) => [operation.name, operation.implemented])).toEqual([
      ["extract", true],
      ["decide", true],
      ["read", false],
    ])
    expect(output?.routes.length).toBeGreaterThan(0)
  })

  test("plan quotes an eligible extract without reading or sending anything", async () => {
    const answer = await run.call("plan", {
      task: "extract",
      input: { profile: "extract-typed", source: { kind: "text", text: "Total EUR 120.00" }, fields: { total: { type: "number", decimals: 2 } } },
    })
    expect(answer.ok).toBe(true)
    const output = answer.ok ? (answer.output as { task: string; route: { status: string; selected?: { route: { model: string } } }; execution: { available: boolean } }) : undefined
    expect(output?.task).toBe("extract")
    expect(output?.route.selected?.route.model).toBe("cloudflare/clairic")
    expect(output?.execution.available).toBe(true)
  })

  test("probe reports the missing sign-in for a known alias and emits the account nudge", async () => {
    const answer = await run.call("probe", { account: "work" })
    expect(answer.ok).toBe(false)
    expect(answer.ok === false ? answer.code : undefined).toBe("NEEDS_SIGN_IN")
  })

  test("a non-read method over RPC with an allow rule and no grant is refused", async () => {
    const answer = await run.call("extract", { account: "work", model: "cloudflare/clairic", source: { kind: "text", text: "Total EUR 1.00" }, fields: { total: { type: "number" } } }, { rules: [{ action: "*", resource: "*", effect: "allow" }] })
    expect(answer.ok).toBe(false)
    expect(answer.ok === false ? answer.code : undefined).toBe("PERMISSION_DENIED")
  })
})

describe("the access levels on the real host", () => {
  for (const level of ["ask-changes", "read-only"] as const) {
    test(`${level} gives every send the contract's effect and keeps the reads on`, async () => {
      const other = await createHost({ directory: ROOT, version: "2.4.1", pluginId: manifest.plugin.name, options: { ...OPTIONS, access: level } })
      try {
        expect(other.failure).toBeUndefined()
        for (const agent of other.agents.filter((item) => evaluate(item.permissions, "*", "*") !== "deny")) {
          for (const method of ["status", "probe", "capabilities", "plan"]) expect(evaluate(agent.permissions, `inference.${method}`, "*")).toBe("allow")
          for (const method of ["extract", "decide"]) expect(evaluate(agent.permissions, `inference.${method}`, "*")).toBe(effectFor(manifest.methods[method]!, level))
        }
      } finally {
        await other.close()
      }
    })
  }
})

describe("an unsupported host", () => {
  test("2.5.0 refuses with HOST_UNTESTED and a next step", async () => {
    const refused = await createHost({ directory: ROOT, version: "2.5.0", pluginId: manifest.plugin.name, options: { ...OPTIONS, allowUntestedHost: false } })
    try {
      expect(refused.refusal).toStartWith("HOST_UNTESTED:")
      expect(refused.refusal).toContain("Next step: ")
    } finally {
      await refused.close()
    }
  })
})
