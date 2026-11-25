import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"
import { accountsOf, type AccountProfile } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { unguardedAgents, type AgentLike } from "@we-the-rebel-alliance/plugin-contract/access"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { assertHost, register, type MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { register as registerAccounts } from "./accounts.js"
import { createAuthorize } from "./authorize.js"
import { commandTransform } from "./commands.js"
import { loadConfig } from "./domain/config.js"
import { InferenceError } from "./domain/errors.js"
import { files } from "./files.js"
import { createHandlers } from "./handlers/index.js"
import { journalDirectory, journalStore, stateRoot } from "./journal-store.js"
import { OPENROUTER_CAPABILITIES } from "./provider/capabilities.js"
import { decisionsAdapter } from "./provider/decisions.js"
import { extractionsAdapter } from "./provider/extractions.js"
import { createTransport } from "./provider/http.js"
import { Journal } from "./runtime/journal.js"
import type { OperationRuntime } from "./runtime/operation.js"
import { loadSkills, skillTransform } from "./skills.js"
import type { StatusView } from "./status-text.js"

// The server entry: one `Plugin.define`, the host gate, then one `register` call that wires every method through the
// contract's doors. Handlers live in src/handlers/, the provider in src/provider/ and the accounts wiring in
// src/accounts.ts. Nothing here writes door code, permission code or a bus.

// One level below the package root both as source (src/) and as the bundle (dist/).
const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; capabilities: Manifest }
const manifest = pkg.capabilities

export default Plugin.define({
  id: manifest.plugin.name,

  async setup(context) {
    // First, so an untested OpenCode leaves no half-wired plugin behind.
    assertHost(context, manifest)

    const config = loadConfig(context.options)
    const plan = accountsOf(manifest, context.options ?? {})
    if (!plan.ok) throw new InferenceError("OPTIONS_INVALID", `The plugin's accounts option is invalid: ${plan.problems.join("; ")}.`)
    const profiles: readonly AccountProfile[] = plan.value.accounts

    const accounts = await registerAccounts(context, manifest, context.options)
    // Optional content: a bad skill is skipped and reported in status, never a setup failure.
    const { skills, problems: skillProblems } = await loadSkills(packageRoot)

    const root = stateRoot()
    const journals = new Map<string, Journal>()
    const operation: OperationRuntime = {
      config,
      fixture: OPENROUTER_CAPABILITIES,
      project: { id: context.location.project.id, directory: context.location.directory, worktree: context.location.project.directory },
      files,
      authorize: createAuthorize((input) => context.permission.assert(input)),
      transport: createTransport(context.integration),
      journal: (scope) => {
        const journal = journals.get(scope) ?? new Journal(journalStore(journalDirectory(root, scope)), scope)
        journals.set(scope, journal)
        return journal
      },
      adapters: { extract: extractionsAdapter, decide: decisionsAdapter },
    }

    const accountProblems = [...accounts.problems, ...skillProblems]
    const handlers = createHandlers({
      manifest,
      version: pkg.version,
      hostVersion: context.app.version,
      config,
      fixture: OPENROUTER_CAPABILITIES,
      profiles,
      accountProblems,
      integration: context.integration,
      operation,
    })

    const registration = await register(context, manifest, handlers)

    // The command posts the same answer the status method returns: one status answer, one place it is built.
    const status = async (): Promise<StatusView> => {
      const agents = await context.agent.list().catch(() => ({ data: [] as readonly AgentLike[] }))
      const call = { unguardedAgents: async () => ({ ok: true as const, agents: unguardedAgents(agents.data as readonly AgentLike[], registration.access.rules) }) }
      return (await handlers.status!.run({}, call as unknown as MethodCall)) as StatusView
    }

    const stops: { dispose(): Promise<void> | void }[] = []
    try {
      stops.push(await context.skill.transform(skillTransform(skills, (module) => config.modules[module])))
      stops.push(await context.command.transform(commandTransform({ synthetic: (input) => context.session.synthetic(input), status })))
    } catch (error) {
      for (const stop of stops.reverse()) await Promise.resolve(stop.dispose()).catch(() => undefined)
      await registration.dispose().catch(() => undefined)
      throw error
    }

    return async () => {
      for (const stop of stops.reverse()) await Promise.resolve(stop.dispose()).catch(() => undefined)
      await registration.dispose()
    }
  },
})
