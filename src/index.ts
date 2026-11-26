import { readFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { accountsOf, type AccountProfile } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { rulesFor } from "@we-the-rebel-alliance/plugin-contract/access"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { register as registerAccounts } from "./accounts.js"
import { createAuthorize } from "./authorize.js"
import { commandStatus, commandTransform } from "./commands.js"
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
import { readSkills, registerSkills } from "./skills.js"

// The server entry: one `Plugin.define`, the host gate, then one `register` call that wires every method through the
// contract's doors. Handlers live in src/handlers/, the provider in src/provider/ and the accounts wiring in
// src/accounts.ts. Nothing here writes door code, permission code or a bus.

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
    // The main skill always; the two topic skills while their module is on. The loader checks every file as YAML first.
    const skillModules = new Map<string, "extractions" | "decisions">([
      ["inference-extract", "extractions"],
      ["inference-decide", "decisions"],
    ])
    const skills = readSkills().filter((skill) => {
      const module = skillModules.get(skill.id)
      return module === undefined || config.modules[module]
    })

    const accounts = await registerAccounts(context, manifest, context.options)

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

    const accountProblems = [...accounts.problems]
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

    // The command posts the same answer the status method returns: one status answer, one place it is built. The rules
    // are the access module's pure function of the manifest and the options, because the registration no longer exposes
    // them; the handler itself reads the rules' live result from its call.
    const rules = rulesFor(manifest, config.access, profiles.map((profile) => profile.alias))
    const status = () => commandStatus(handlers.status!, () => context.agent.list(), rules)

    const stops: { dispose(): Promise<void> | void }[] = []
    try {
      stops.push(await registerSkills(context, skills))
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
