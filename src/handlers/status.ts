import { accountStatuses, NO_ACCOUNTS, redactReason, STATUS_SCHEMA, statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { accountSignals } from "../accounts.js"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { HandlerDeps } from "./deps.js"
import { EMPTY_INPUT } from "./schemas.js"

// `status` is required on every plugin (contract §11). It reads no key and calls no provider: its answer is the
// manifest, the host release, each alias's connection state and the agents whose rules no longer hold.

const DESCRIPTION =
  "Read Inference's state: the OpenCode range it runs on, every account alias and whether it is signed in, and which agents lack the generated access rules. It never reads a key and calls no provider."

export function statusHandler(deps: HandlerDeps): MethodHandler {
  return {
    description: DESCRIPTION,
    input: EMPTY_INPUT,
    output: STATUS_SCHEMA,
    async run(_input, call) {
      const problems = [...deps.accountProblems]
      let unguarded: readonly string[] = []
      try {
        unguarded = await call.unguardedAgents()
      } catch (error) {
        // An unreadable agent list is unknown, never zero: status says error, with a redacted next step.
        problems.push(redactReason(error instanceof Error ? error.message : String(error)))
      }
      let accounts = NO_ACCOUNTS
      if (deps.profiles.length > 0) {
        const signals = await accountSignals(deps.integration, deps.profiles)
        accounts = accountStatuses(deps.profiles, signals)
        // An alias whose saved key OpenCode rejects is a reason the plugin is not ready, not only a per-account note:
        // status says error and its next step names the alias.
        for (const account of accounts) if (account.state === "error" && account.reason !== undefined) problems.push(`${account.alias}: ${account.reason}`)
      }
      return statusAnswer({
        manifest: deps.manifest,
        version: deps.version,
        hostVersion: deps.hostVersion,
        accounts,
        problems,
        unguardedAgents: unguarded,
      })
    },
  }
}
