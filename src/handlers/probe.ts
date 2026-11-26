import { probeResult, PROBE_SCHEMA } from "@we-the-rebel-alliance/plugin-contract/events"
import { refusal, RegisterError, type MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { accountSignal, integrationName, ownerOf } from "../accounts.js"
import type { HandlerDeps } from "./deps.js"
import { EMPTY_INPUT } from "./schemas.js"

// `probe` (contract §11): whose the account is and whether its sign-in is usable. It reads no content. OpenCode knows
// the integration is signed in, not whose OpenRouter account the key belongs to, so the owner is unverified (see
// src/accounts.ts ownerOf).

const DESCRIPTION =
  "Probe one account's sign-in: whether OpenCode holds a usable OpenRouter key for that alias, and the integration that holds it. It reads no content and never the key."

export function probeHandler(deps: HandlerDeps): MethodHandler {
  return {
    description: DESCRIPTION,
    input: EMPTY_INPUT,
    output: PROBE_SCHEMA,
    async run(_input, call) {
      const signal = await accountSignal(deps.integration, call.account)
      if (signal.state !== "ready") {
        // A probe is where the plugin learns an account needs attention: nudge every app, then refuse.
        await call.bus.emit("account", { account: call.account, state: signal.state })
        throw new RegisterError(
          refusal(
            "NEEDS_SIGN_IN",
            `${call.account} is not signed in to OpenRouter${signal.reason === undefined ? "" : `: ${signal.reason}`}`,
            `Run /connect and choose ${integrationName(call.account)}, then enter an OpenRouter API key.`,
          ),
        )
      }
      await call.bus.emit("account", { account: call.account, state: "ready" })
      return probeResult({ source: "openrouter", account: call.account, owner: ownerOf(call.account) })
    },
  }
}
