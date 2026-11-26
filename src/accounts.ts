import type { Plugin } from "@opencode/plugin"
import { accountName, registerAccounts, type AccountProfile, type AccountSignal, type AccountsRegistration } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { PLUGIN_NAME } from "./domain/ids.js"

// The profile and credential wiring, through the contract's accounts module. One OpenCode integration per alias, named
// `inference` for `default` and `inference-<alias>` otherwise, each holding one OpenRouter key as a `key` auth method.
// A profile has no fields: the key belongs to the alias, and nothing about the provider is configured per account.

/** The integration id one alias signs in to. The transport resolves the key from exactly this id. */
export const integrationName = (alias: string) => accountName(PLUGIN_NAME, alias)

/** The part of the host context the account wiring uses. */
export type AccountsHost = Pick<Plugin.Context, "integration" | "mcp">

/** Registers one integration per alias and its key auth method. A failure is recorded for status, never thrown. */
export function register(context: AccountsHost, manifest: Manifest, options: Readonly<Record<string, unknown>> | undefined): Promise<AccountsRegistration> {
  return registerAccounts(context, {
    manifest,
    ...(options === undefined ? {} : { options }),
    auth: (account: AccountProfile, integrationID: string) => [
      { integrationID, method: { type: "key", label: `OpenRouter API key for the ${account.alias} account` } },
    ],
  })
}

/** The part of the integration domain the connection state reads: presence and status, never the key. */
export type ConnectionHost = Pick<Plugin.Context["integration"], "connection">

/**
 * One alias's state, from its active connection. The key is never resolved. A connection OpenCode reports a problem
 * for is an `error` (its saved key is not usable); no connection is `needs_sign_in`.
 */
export async function accountSignal(integration: ConnectionHost, alias: string): Promise<AccountSignal> {
  try {
    const connection = await integration.connection.active(integrationName(alias))
    if (!connection) return { state: "needs_sign_in" }
    if (connection.status) return { state: "error", reason: "OpenCode reports a problem with this account's saved key." }
    return { state: "ready" }
  } catch {
    return { state: "error", reason: "OpenCode did not report this account's connection." }
  }
}

/**
 * Every alias's state, in the options' order. An alias with no connection is left out: `accountStatuses` answers its
 * own "Not signed in yet." for a missing signal, so the sentence is the contract module's, not a copy.
 */
export async function accountSignals(integration: ConnectionHost, profiles: readonly AccountProfile[]): Promise<Readonly<Record<string, AccountSignal>>> {
  const entries = await Promise.all(profiles.map(async (profile) => [profile.alias, await accountSignal(integration, profile.alias)] as const))
  return Object.fromEntries(entries.filter(([, signal]) => signal.state !== "needs_sign_in"))
}

/**
 * The owner a probe reports, without reading the key. OpenCode knows which integration is signed in, not whose
 * OpenRouter account the key belongs to, so `verified` is false: the probe proves the credential is present and usable
 * by OpenCode, never the account behind it.
 */
export function ownerOf(alias: string) {
  const name = integrationName(alias)
  return { id: `integration:${name}`, label: `${name} (OpenRouter API key)`, verified: false as const }
}
