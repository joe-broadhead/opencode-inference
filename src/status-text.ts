// The status answer as people read it, for the `/inference` command and the TUI dialog. It is a structural copy of the
// contract's status shape: the TUI bundle imports this module, so it names no zod and no contract runtime.

export interface StatusView {
  readonly name: string
  readonly version: string
  readonly host: { readonly version: string; readonly range: string; readonly tested: readonly string[] }
  readonly state: "ready" | "needs_sign_in" | "error"
  readonly accounts: readonly { readonly alias: string; readonly state: "ready" | "needs_sign_in" | "error"; readonly reason?: string }[]
  readonly unguardedAgents: readonly string[]
  readonly nextStep: string | null
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  ready: "ready",
  needs_sign_in: "needs sign-in",
  error: "error",
}

/** The accounts row: every alias and its state, or a sentence when the plugin has no accounts. */
export function accountsText(view: StatusView): string {
  if (view.accounts.length === 0) return "none: this plugin signs in to nothing"
  return view.accounts.map((account) => `${account.alias} ${STATE_TEXT[account.state] ?? account.state}${account.reason === undefined ? "" : ` (${account.reason})`}`).join("; ")
}

/** The whole answer, one line per fact, ending with the next step. */
export function statusText(view: StatusView): string {
  return [
    `Inference ${view.version} status: ${STATE_TEXT[view.state] ?? view.state}`,
    `OpenCode: ${view.host.version} (supported ${view.host.range}; tested ${view.host.tested.join(", ")})`,
    `Accounts: ${accountsText(view)}`,
    `Agents without the generated rules: ${view.unguardedAgents.length === 0 ? "none" : view.unguardedAgents.join(", ")}`,
    `Next step: ${view.nextStep ?? "none"}`,
  ].join("\n")
}
