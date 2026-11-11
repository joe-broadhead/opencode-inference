import { describe, expect, test } from "bun:test"
import { ACCESS_VALUES, type Access, type Rule } from "../../src/domain/ids.js"
import { actionOf, PLANNED, TOOLS } from "../../src/domain/registry.js"
import { createAuthorize, defaultRules, evaluate, hasDefaultRules, insertRules, unguardedAgents } from "../../src/host/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

describe("the default block", () => {
  test("is generated from the registry's classes: the namespace pattern first, then each registered tool", () => {
    expect(defaultRules("all")).toEqual([rule("inference_*", "allow"), rule("inference_status", "allow"), rule("inference_capabilities", "allow"), rule("inference_plan", "allow")])
    expect(defaultRules("ask-changes")).toEqual([rule("inference_*", "ask"), rule("inference_status", "allow"), rule("inference_capabilities", "allow"), rule("inference_plan", "allow")])
    expect(defaultRules("read-only")).toEqual([rule("inference_*", "deny"), rule("inference_status", "allow"), rule("inference_capabilities", "allow"), rule("inference_plan", "allow")])
    expect(defaultRules().map((item) => item.action).slice(1)).toEqual(TOOLS.map((tool) => actionOf(tool.name)))
  })

  test("names no planned tool: the send tools a later release adds are covered by the namespace rule only", () => {
    for (const access of ACCESS_VALUES) for (const operation of PLANNED) expect(defaultRules(access).map((item) => item.action)).not.toContain(operation.tool)
  })
})

describe("the access matrix, through the host's last-match evaluation after a base allow", () => {
  const expected: Record<Access, { read: Rule["effect"]; send: Rule["effect"] }> = {
    all: { read: "allow", send: "allow" },
    "ask-changes": { read: "allow", send: "ask" },
    "read-only": { read: "allow", send: "deny" },
  }
  for (const access of ACCESS_VALUES)
    test(`access: ${access}`, () => {
      const rules = [BASE, ...defaultRules(access)]
      for (const tool of TOOLS) expect({ tool: tool.name, effect: evaluate(rules, actionOf(tool.name)) }).toEqual({ tool: tool.name, effect: expected[access].read })
      for (const operation of PLANNED) expect({ tool: operation.tool, effect: evaluate(rules, operation.tool) }).toEqual({ tool: operation.tool, effect: expected[access].send })
      // A user's later rule still wins over the block.
      expect(evaluate([...rules, rule("inference_plan", "deny")], "inference_plan")).toBe("deny")
    })
})

describe("insertion", () => {
  test("goes directly after the base allow, before the agent's own later rules", () => {
    const permissions = [rule("read", "allow"), BASE, rule("edit", "deny")]
    expect(insertRules(permissions)).toBe(true)
    expect(permissions).toEqual([rule("read", "allow"), BASE, ...defaultRules(), rule("edit", "deny")])
  })

  test("is idempotent: a replayed transform does not double the block", () => {
    const permissions = [BASE]
    insertRules(permissions, "ask-changes")
    expect(insertRules(permissions, "ask-changes")).toBe(false)
    expect(permissions).toEqual([BASE, ...defaultRules("ask-changes")])
  })

  test("leaves agents without a base allow alone, so a default deny is never loosened", () => {
    const permissions = [rule("*", "deny"), rule("read", "allow")]
    expect(insertRules(permissions)).toBe(false)
    expect(permissions).toEqual([rule("*", "deny"), rule("read", "allow")])
  })
})

describe("exact-block detection", () => {
  test("finds the whole block anywhere after the base allow, as another plugin may insert before it", () => {
    expect(hasDefaultRules([BASE, rule("other_*", "allow"), ...defaultRules()])).toBe(true)
  })

  test("a partial block is not installed", () => {
    const block = defaultRules()
    expect(hasDefaultRules([BASE, ...block.slice(0, -1)])).toBe(false)
    expect(hasDefaultRules([BASE, ...block.slice(1)])).toBe(false)
    expect(hasDefaultRules([BASE, block[0]!, rule("other", "allow"), ...block.slice(1)])).toBe(false)
  })

  test("a block for another access value, or before the base allow, is not installed", () => {
    expect(hasDefaultRules([BASE, ...defaultRules("all")], "read-only")).toBe(false)
    expect(hasDefaultRules([...defaultRules(), BASE])).toBe(false)
    expect(hasDefaultRules(defaultRules())).toBe(false)
  })
})

describe("unguarded agents", () => {
  const agents = [
    { id: "build", permissions: [BASE, ...defaultRules("ask-changes")] },
    { id: "reviewer", permissions: [BASE] },
    { id: "partial", permissions: [BASE, ...defaultRules("ask-changes").slice(1)] },
    { id: "careful", permissions: [BASE, rule("inference_*", "ask")] },
    { id: "locked", permissions: [rule("*", "deny")] },
  ]

  test("at ask-changes or read-only: agents with a base allow, no exact block, and rules that would run a send", () => {
    expect(unguardedAgents(agents, "ask-changes")).toEqual(["reviewer", "partial"])
    // build carries the ask-changes block, not the read-only one, but its own rules already ask for a send.
    expect(unguardedAgents(agents, "read-only")).toEqual(["reviewer", "partial"])
    expect(unguardedAgents([{ id: "build", permissions: [BASE, ...defaultRules("all")] }], "read-only")).toEqual(["build"])
  })

  test("at all nothing is held back, so none is listed", () => {
    expect(unguardedAgents(agents, "all")).toEqual([])
  })
})

describe("the one-argument assert", () => {
  const call = (signal = new AbortController().signal) => ({ sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal })

  test("asserts each request in order, with one argument and the tool source", async () => {
    const seen: unknown[][] = []
    const authorize = createAuthorize(((...args: unknown[]) => {
      seen.push(args)
      return Promise.resolve()
    }) as never)
    await authorize([{ action: "read", resources: ["/a"] }, { action: "inference_extract", resources: ["openrouter.ai"], save: ["openrouter.ai"] }], call())
    expect(seen.map((args) => args.length)).toEqual([1, 1])
    expect(seen[1]![0]).toEqual({ sessionID: "ses_1", agent: "build", source: { type: "tool", messageID: "msg_1", id: "call_1" }, action: "inference_extract", resources: ["openrouter.ai"], save: ["openrouter.ai"] })
  })

  test("a late approval after cancellation causes nothing: the next request is never asserted", async () => {
    const controller = new AbortController()
    let release: () => void = () => undefined
    const asked: string[] = []
    const authorize = createAuthorize(((input: { action: string }) => {
      asked.push(input.action)
      return new Promise<void>((resolve) => (release = resolve))
    }) as never)
    const pending = authorize([{ action: "read", resources: ["/a"] }, { action: "inference_extract", resources: ["x"] }], call(controller.signal))
    controller.abort()
    release()
    await expect(pending).rejects.toThrow(/^CANCELLED:/)
    expect(asked).toEqual(["read"])
  })

  test("host permission errors propagate unchanged", async () => {
    const denied = Object.assign(new Error("Permission denied: read"), { _tag: "Permission.DeniedError" })
    const authorize = createAuthorize((() => Promise.reject(denied)) as never)
    await expect(authorize([{ action: "read", resources: ["/a"] }], call())).rejects.toBe(denied)
  })
})
