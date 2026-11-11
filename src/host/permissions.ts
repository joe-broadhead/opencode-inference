import type { Plugin } from "@opencode/plugin"
import { fence, InferenceError } from "../domain/errors.js"
import { NAMESPACE_ACTION, type Access, type Rule } from "../domain/ids.js"
import { actionOf, PLANNED, TOOLS } from "../domain/registry.js"

// The family default-rule block, generated from the registry's classes and the `access` option, and inserted directly
// after each agent's base `* * allow`, so the agent's own stricter rules, the user's rules and saved approvals still win.
// The matcher is the exact-block one: an agent is guarded only when the whole block appears contiguously after its base
// allow. A partial block is not "installed".

const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect
const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/** The effect a class gets under `access`: reads always run; everything else follows the option. */
export const effectOf = (methodClass: string, access: Access): Rule["effect"] =>
  methodClass === "read" || access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"

/**
 * Broad first, narrow last, because the last matching rule wins: the namespace pattern covers every Inference action,
 * including the send tools a later release adds; each registered tool then gets its class's effect.
 */
export const defaultRules = (access: Access = "all"): Rule[] => [
  rule(NAMESPACE_ACTION, effectOf("send", access)),
  ...TOOLS.map((tool) => rule(actionOf(tool.name), effectOf(tool.class, access))),
]

/** True when the block appears as one contiguous run anywhere after the agent's first base allow. */
export function hasDefaultRules(permissions: readonly Rule[], access: Access = "all") {
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  const block = defaultRules(access)
  return permissions.some((_, start) => start > base && block.every((item, offset) => permissions[start + offset] !== undefined && same(permissions[start + offset]!, item)))
}

/**
 * Splices the block in right after the base allow. Agents without a base allow are left alone (the namespace rule would
 * loosen a default deny), and so are agents that already carry the block, so a replayed transform never doubles it.
 * Returns whether it inserted.
 */
export function insertRules(permissions: Rule[], access: Access = "all") {
  if (hasDefaultRules(permissions, access)) return false
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  permissions.splice(base + 1, 0, ...defaultRules(access).map((item) => ({ ...item })))
  return true
}

/** The agent transform. Synchronous and never throws; a failure is reported for status. */
export function registerDefaultRules(agent: Pick<Plugin.Context["agent"], "transform">, access: Access, report: (problem: string | undefined) => void) {
  return agent.transform((editor) => {
    try {
      for (const { id } of editor.list()) editor.update(id, (info) => void insertRules(info.permissions as Rule[], access))
      report(undefined)
    } catch {
      report(new InferenceError("RULES_NOT_ADDED").message)
    }
  })
}

const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)
/** The host's evaluation for one action on resource `*`: the last matching rule wins, and no match asks. */
export const evaluate = (permissions: readonly Rule[], action: string): Rule["effect"] =>
  permissions.findLast((item) => wildcard(item.action).test(action) && wildcard(item.resource).test("*"))?.effect ?? "ask"

/**
 * Agents where the block never arrived (config-only agents, agents added by later plugins) and whose own rules would
 * run a send without asking. At `all` nothing is held back, so none is listed. The probes are the planned send actions.
 */
export const unguardedAgents = (agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all") =>
  access === "all"
    ? []
    : agents
        .filter((agent) => agent.permissions.some((item) => same(item, BASE_ALLOW)) && !hasDefaultRules(agent.permissions, access))
        .filter((agent) => PLANNED.some((operation) => evaluate(agent.permissions, operation.tool) === "allow"))
        .map((agent) => agent.id)

// --- The one-argument assert, for the effects a later release asserts (file reads, sends) -------------------------

type Assert = Plugin.Context["permission"]["assert"]
export interface PermissionRequest {
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
}
export interface AssertCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

/** Waits for one plain assert, but gives up when the signal aborts. A late approval causes no effect: the fence rejects it. */
async function assertOne(assert: Assert, input: Parameters<Assert>[0], signal: AbortSignal) {
  fence(signal)
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new InferenceError("CANCELLED"))
    signal.addEventListener("abort", abort, { once: true })
    assert(input).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
  fence(signal)
}

/** Asserts each request in order as the calling tool. Host permission errors propagate unchanged. */
export function createAuthorize(assert: Assert) {
  return async (requests: readonly PermissionRequest[], call: AssertCall) => {
    for (const item of requests)
      await assertOne(
        assert,
        {
          sessionID: call.sessionID,
          agent: call.agent,
          source: { type: "tool", messageID: call.messageID, id: call.id },
          action: item.action,
          resources: [...item.resources],
          ...(item.save ? { save: [...item.save] } : {}),
          ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
        } as Parameters<Assert>[0],
        call.signal,
      )
  }
}
