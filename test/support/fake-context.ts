// A narrow fake of the server plugin context, typed loosely against the public @opencode/plugin 2.2.3 API, for unit
// tests that need to see what setup registers and disposes. No host source. Host tests use the real embedded host.
import type { Plugin } from "@opencode/plugin"

type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
export interface Registered {
  readonly kind: string
  readonly id: number
  disposed: boolean
}
export interface FakeTool {
  readonly name: string
  readonly description: string
  readonly input: unknown
  readonly output: unknown
  readonly options: { namespace?: string; permission?: string; pinned?: boolean }
  readonly execute: (input: unknown, context: unknown) => Promise<{ output: unknown; content?: unknown }>
}
export interface FakeOptions {
  /** Throws from the nth registration (1-based), to test failure cleanup. */
  readonly failAt?: number
  readonly options?: Record<string, unknown>
  readonly version?: string
  readonly agents?: { id: string; permissions: Rule[] }[]
  /** The active connection of the inference-openrouter integration, if any. */
  readonly connection?: { type: "credential"; status?: unknown } | undefined
  readonly sessions?: Record<string, { agent?: string; permissions?: Rule[] }>
  /**
   * Emulate the host's assert: evaluate the agent's and the session's rules for each resource, run the registered
   * `evaluate` hooks, throw a host tool error on deny, and call `onAsk` on ask (rejecting when it is not given).
   * Without it, assert allows everything.
   */
  readonly hostPermissions?: boolean
  readonly onAsk?: (request: AssertRequest) => Promise<"once" | "reject">
}

export interface AssertRequest {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly source?: { type: "tool"; messageID: string; id: string }
}

const wildcard = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)
const ruleEffect = (rules: readonly Rule[], action: string, resource: string) => rules.findLast((rule) => wildcard(rule.action, action) && wildcard(rule.resource, resource))?.effect ?? "ask"
/** The host's tool error: a tagged error whose cause carries the request for an ask. */
const hostError = (message: string, cause: unknown) => Object.assign(new Error(message), { _tag: "Tool.Error", error: cause })

export function fakeContext(input: FakeOptions = {}) {
  let count = 0
  const registrations: Registered[] = []
  const register = async (kind: string) => {
    count++
    if (input.failAt === count) throw new Error(`fake registration ${count} (${kind}) failed`)
    const item: Registered = { kind, id: count, disposed: false }
    registrations.push(item)
    return { dispose: async () => void (item.disposed = true) }
  }
  const agents = input.agents ?? [
    { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    { id: "plan", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }] },
    { id: "locked", permissions: [{ action: "*", resource: "*", effect: "deny" }] },
  ]
  const tools: FakeTool[] = []
  const namespaces: { name: string; description: string }[] = []
  const integrations = new Map<string, { id: string; name: string }>()
  const methods: unknown[] = []
  const rpc = new Map<string, { contract: { id: string; methods: Record<string, unknown> }; handlers: Record<string, (input: unknown, context: unknown) => unknown> }>()
  const commands: { name: string; execute: (input: unknown) => Promise<void> }[] = []
  const synthetic: { text: string }[] = []
  const hooks: { name: string; callback: unknown }[] = []
  const asserted: AssertRequest[] = []
  const resolved: unknown[] = []
  let agentTransform: ((editor: unknown) => void) | undefined

  const agentEditor = () => ({
    list: () => agents.map((agent) => ({ id: agent.id })),
    update: (id: string, update: (agent: { permissions: Rule[] }) => void) => {
      const agent = agents.find((item) => item.id === id)
      if (agent) update(agent)
    },
  })

  const context = {
    app: { version: input.version ?? "2.2.3" },
    location: { directory: "/fake/project", project: { id: "prj_fake", directory: "/fake/project" } },
    options: input.options ?? {},
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        const registration = await register("integration")
        callback({
          list: () => [...integrations.values()],
          get: (id: string) => integrations.get(id),
          update: (id: string, update: (item: { id: string; name: string }) => void) => {
            const item = integrations.get(id) ?? { id, name: id }
            update(item)
            integrations.set(id, item)
          },
          remove: (id: string) => integrations.delete(id),
          method: { list: () => methods, update: (method: unknown) => methods.push(method), remove: () => undefined },
        })
        return registration
      },
      connection: {
        active: async () => input.connection,
        resolve: async (connection: unknown) => {
          resolved.push(connection)
          return { type: "key", key: "sk-or-fake-should-never-be-read" }
        },
        status: async () => undefined,
      },
    },
    agent: {
      transform: async (callback: (editor: unknown) => void) => {
        const registration = await register("agent")
        agentTransform = callback
        callback(agentEditor())
        return registration
      },
      list: async () => ({ data: agents }),
      get: async ({ agentID }: { agentID: string }) => {
        const agent = agents.find((item) => item.id === agentID)
        if (!agent) throw new Error(`Agent not found: ${agentID}`)
        return { data: agent }
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        const registration = await register("tool")
        callback({
          namespace: (namespace: { name: string; description: string }) => namespaces.push(namespace),
          add: (tool: FakeTool) => tools.push(tool),
          list: () => tools,
          get: () => undefined,
          update: () => undefined,
          remove: () => undefined,
        })
        return registration
      },
      list: async () => tools.map((tool) => ({ ...tool, id: `inference_${tool.name}` })),
      reload: async () => undefined,
    },
    rpc: {
      register: async (contract: { id: string; methods: Record<string, unknown> }, handlers: Record<string, (input: unknown, context: unknown) => unknown>) => {
        const registration = await register(`rpc:${contract.id}`)
        rpc.set(contract.id, { contract, handlers })
        return { ...registration, events: { emit: async () => undefined } }
      },
    },
    permission: {
      hook: async (name: string, callback: unknown) => {
        hooks.push({ name, callback })
        return register(`hook:${name}`)
      },
      assert: async (request: AssertRequest) => {
        asserted.push(request)
        if (!input.hostPermissions) return
        const agent = agents.find((item) => item.id === request.agent)
        const rules = [...(agent?.permissions ?? []), ...(input.sessions?.[request.sessionID]?.permissions ?? [])]
        const effects = request.resources.map((resource) => ruleEffect(rules, request.action, resource))
        let effect: Rule["effect"] = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
        if (effect === "deny") throw hostError(`Permission denied: ${request.action}`, {})
        for (const hook of hooks.filter((item) => item.name === "evaluate")) {
          type Evaluation = { source: AssertRequest["source"]; action: string; resources: readonly string[]; effect: Rule["effect"]; message: string | undefined }
          const evaluation: Evaluation = { source: request.source, action: request.action, resources: request.resources, effect, message: undefined }
          ;(hook.callback as (value: Evaluation) => void)(evaluation)
          effect = evaluation.effect
        }
        if (effect === "deny") throw hostError(`Permission refused: ${request.action}`, { request: { action: request.action } })
        if (effect === "ask" && (await (input.onAsk?.(request) ?? Promise.resolve("reject" as const))) === "reject")
          throw hostError(`The user rejected ${request.action}`, { request: { action: request.action } })
      },
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        const registration = await register("command")
        callback({ add: (command: { name: string; execute: (input: unknown) => Promise<void> }) => commands.push(command) })
        return registration
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = input.sessions?.[sessionID]
        if (!session) throw Object.assign(new Error("not found"), { _tag: "Session.NotFoundError" })
        return session
      },
      synthetic: async (message: { text: string }) => void synthetic.push(message),
    },
    mcp: { list: async () => ({ data: [] }) },
  }

  /** Calls a registered RPC method as a host would, turning `context.error(...)` into a returned error object. */
  const call = async (rpcID: string, method: string, value: unknown) => {
    const entry = rpc.get(rpcID)
    if (!entry) throw new Error(`no RPC ${rpcID}`)
    const handler = entry.handlers[method]
    if (!handler) throw new Error(`no method ${method} on ${rpcID}`)
    return handler(value, { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ error: { type, message, data } }) })
  }

  return {
    context: context as unknown as Plugin.Context,
    registrations,
    tools,
    namespaces,
    integrations,
    methods,
    rpc,
    commands,
    synthetic,
    hooks,
    asserted,
    agents,
    resolved,
    call,
    /** Replays the agent transform, as the host does on a rebuild. */
    replayAgents: () => agentTransform?.(agentEditor()),
    live: () => registrations.filter((item) => !item.disposed),
  }
}
