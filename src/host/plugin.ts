import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { loadConfig } from "../domain/config.js"
import { InferenceError, formatFailure } from "../domain/errors.js"
import { PLUGIN_ID, type Rule, type StatusView } from "../domain/ids.js"
import { TOOLS } from "../domain/registry.js"
import { StatusSchema } from "../domain/status-schema.js"
import { OPENROUTER_CAPABILITIES, type CapabilityFixture } from "../providers/openrouter/capabilities.js"
import { compactStatus, formatSummary, Inference } from "../rpc.js"
import { createDispatcher } from "../runtime/dispatch.js"
import { createHandlers } from "../runtime/handlers.js"
import { Journal } from "../runtime/journal.js"
import type { Adapter, OperationRuntime } from "../runtime/operation.js"
import { decisionsAdapter } from "../providers/openrouter/decisions.js"
import { extractionsAdapter } from "../providers/openrouter/extractions.js"
import { createTransport } from "../providers/openrouter/http.js"
import { commandTransform } from "./commands.js"
import { checkHost } from "./compat.js"
import { connectionState, registerIntegration } from "./integration.js"
import { files } from "./files.js"
import { journalDirectory, journalStore, stateRoot } from "./journal-store.js"
import { createAuthorize, registerDefaultRules } from "./permissions.js"
import { registerScripting } from "./scripting.js"
import { buildStatus } from "./status.js"
import { toolTransform } from "./tools.js"

export interface PluginSources {
  /** The installed package root, which holds package.json. */
  readonly packageRoot: string
  /** The capability fixture; tests pass their own. */
  readonly fixture?: CapabilityFixture
  readonly now?: () => Date
  /** The private state folder for the operation journal; tests pass a temporary one. */
  readonly stateRoot?: string
  /**
   * The transport's origin; tests pass a loopback fake provider. createTransport refuses anything but OpenRouter itself
   * or a loopback address, so this cannot point the key anywhere else.
   */
  readonly transportOrigin?: string
}

/**
 * The provider adapters, by tool name: every non-read tool in the registry has one here. A route still runs only when
 * the fixture enables it, which waits for its compatibility canary.
 */
export const ADAPTERS: Readonly<Record<string, Adapter>> = { extract: extractionsAdapter, decide: decisionsAdapter }

type Disposable = { readonly dispose: () => Promise<void> | void }

/**
 * Everything setup registers, disposed in reverse order exactly once: on cleanup, and on a failure part-way through
 * setup, so a failed or reloaded setup leaves no registration, hook or RPC behind. Later releases push their aborts,
 * workers and subscriptions here too.
 */
export class CleanupStack {
  private readonly items: Disposable[] = []
  private done = false
  push(item: Disposable) {
    if (this.done) {
      void Promise.resolve(item.dispose()).catch(() => undefined)
      return
    }
    this.items.push(item)
  }
  get size() {
    return this.items.length
  }
  async run() {
    this.done = true
    const failures: unknown[] = []
    for (const item of this.items.splice(0).reverse()) {
      try {
        await item.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw failures[0]
  }
}

export function createPlugin(sources: PluginSources): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const config = loadConfig(ctx.options)
      const host = checkHost(ctx.app.version, config.allowUntestedHost)
      if (host.next) console.warn(formatFailure({ code: "HOST_UNTESTED", message: `OpenCode ${host.version} is outside the range Inference supports (${host.range}).`, hint: host.next }))
      const version = (JSON.parse(readFileSync(join(sources.packageRoot, "package.json"), "utf8")) as { version: string }).version
      const fixture = sources.fixture ?? OPENROUTER_CAPABILITIES
      const stack = new CleanupStack()
      let closed = false
      const close = async () => {
        closed = true
        await stack.run()
      }
      try {
        let rulesProblem: string | undefined
        let integrationProblem: string | undefined
        const status = (): Promise<StatusView> =>
          buildStatus({
            version,
            host,
            config,
            fixture,
            connectionState: () => connectionState(ctx.integration),
            agents: async () => (await ctx.agent.list()).data as unknown as readonly { id: string; permissions: readonly Rule[] }[],
            problems: () => [rulesProblem, integrationProblem].filter((problem): problem is string => problem !== undefined),
            ...(sources.now ? { now: sources.now } : {}),
          })
        const handlers = createHandlers({ config, fixture, status: async () => compactStatus(await status()), statusText: formatSummary, ...(sources.now ? { now: sources.now } : {}) })
        const journals = new Map<string, Journal>()
        const root = sources.stateRoot ?? stateRoot()
        const operations: OperationRuntime = {
          config,
          fixture,
          project: { id: ctx.location.project.id, directory: ctx.location.directory, worktree: ctx.location.project.directory },
          files,
          authorize: createAuthorize((input) => ctx.permission.assert(input)),
          transport: createTransport(ctx.integration, sources.transportOrigin),
          journal: (scope) => {
            const journal = journals.get(scope) ?? new Journal(journalStore(journalDirectory(root, scope)), scope, sources.now)
            journals.set(scope, journal)
            return journal
          },
          adapters: ADAPTERS,
          ...(sources.now ? { now: sources.now } : {}),
        }
        // The one dispatcher for the model's tools and the tools RPC. Availability is checked on every call: the plugin
        // is open and the tool's module is on in the trusted options.
        const runTool = createDispatcher({
          tools: TOOLS,
          handlers,
          operations,
          unavailable: (tool) => (closed ? new InferenceError("CLOSED") : tool.module !== undefined && !config.modules[tool.module] ? new InferenceError("MODULE_DISABLED") : undefined),
        })

        try {
          stack.push(await registerIntegration(ctx.integration))
        } catch {
          // /connect is optional in this version: status names the problem and setup carries on.
          integrationProblem = new InferenceError("INTEGRATION_NOT_REGISTERED").message
        }
        stack.push(await registerDefaultRules(ctx.agent, config.access, (problem) => (rulesProblem = problem)))
        stack.push(await ctx.tool.transform(toolTransform(runTool)))
        stack.push(
          await ctx.rpc.register(Inference, {
            status: async (_input: unknown, context: { error(code: "unavailable", message: string, data: { nextStep: string }): unknown }) => {
              try {
                return StatusSchema.parse(await status())
              } catch {
                const failure = new InferenceError("STATUS_UNAVAILABLE")
                return context.error("unavailable", failure.message, { nextStep: failure.hint })
              }
            },
          } as never),
        )
        await registerScripting(ctx, runTool, (registration) => stack.push(registration), () => (closed ? "CLOSED" : undefined))
        stack.push(await ctx.command.transform(commandTransform({ synthetic: (input) => ctx.session.synthetic(input), status })))
        return close
      } catch (error) {
        await close().catch(() => undefined)
        throw error
      }
    },
  }
}
