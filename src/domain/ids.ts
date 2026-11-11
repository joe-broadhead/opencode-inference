// Stable identities and the zod-free shared vocabulary. The TUI bundle imports this file, so it imports nothing.

/** The server plugin, its RPC status contract and the prefix of the tools RPC (`inference.core.tools`). */
export const PLUGIN_ID = "inference.core"
export const TUI_ID = "inference.core.tui"
/** The Code Mode namespace: `tools.inference.<name>`. */
export const NAMESPACE = "inference"
/** Every permission action this plugin asserts or registers starts with this. */
export const PERMISSION_PREFIX = `${NAMESPACE}_`
/** The namespace pattern: the first rule of the default block, covering a tool a later release adds. */
export const NAMESPACE_ACTION = `${NAMESPACE}_*`
export const COMMANDS = { status: "inference-status" } as const
/** The TUI's slash command and palette entry. */
export const TUI_SLASH = "inference"

/** The plugin-owned key integration in /connect. Its key is read only at the transport boundary (a later release). */
export const INTEGRATION_ID = "inference-openrouter"
export const INTEGRATION_NAME = "OpenRouter for Inference"
export const INTEGRATION_KEY_LABEL = "OpenRouter API key"

export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]

/** The family method classes. A tool's class covers its worst branch. */
export const METHOD_CLASSES = ["read", "write", "send", "export", "destructive"] as const
export type MethodClass = (typeof METHOD_CLASSES)[number]

/** Modules: the operations a later release implements, each switched by `modules.<name>`. */
export const MODULES = ["extractions", "decisions", "understanding"] as const
export type Module = (typeof MODULES)[number]

/**
 * - `local_only`: status, capabilities and plan work; no route can send anything (every route in this version).
 * - `sign_in_required`: a route could send, but no OpenRouter key is connected.
 * - `ready`: a route could send and a key is connected.
 * - `disabled`: every module is turned off in the options.
 */
export const STATES = ["ready", "local_only", "sign_in_required", "disabled"] as const
export type StatusState = (typeof STATES)[number]

export const CONNECTION_STATES = ["connected", "not_connected", "needs_auth", "unknown"] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

/** A permission rule, in the host's shape. */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** The one status view: `/inference-status`, the status RPC, the TUI dialog and `inference_status` all render it. */
export interface StatusView {
  readonly version: string
  readonly host: { readonly version: string | null; readonly range: string; readonly tested: boolean; readonly next?: string }
  readonly state: StatusState
  readonly unguardedAgents: readonly string[]
  readonly nextStep: string
  readonly connection: {
    readonly integration: typeof INTEGRATION_ID
    readonly state: ConnectionState
    /** True when an enabled route would need the key. False in this version: no route sends yet. */
    readonly required: boolean
    readonly next?: string
  }
  readonly access: Access
  readonly modules: { readonly [M in Module]: { readonly enabled: boolean } }
  readonly tools: { readonly registered: readonly string[]; readonly planned: readonly string[] }
  readonly capabilities: {
    readonly revision: string
    readonly reviewedOn: string
    readonly ageDays: number
    readonly stale: boolean
    readonly basis: "documentation"
    readonly routes: number
    readonly enabledRoutes: number
  }
  readonly spend: {
    readonly currency: "USD"
    readonly requestUsd: string
    readonly sessionUsd: string
    readonly rolling24hUsd: string
    /** `none`: no journal exists yet, so nothing is committed, reserved or unknown. */
    readonly tracking: "none"
  }
  readonly operations: { readonly tracking: "none" }
  readonly permissions: { readonly block: readonly Rule[] }
  readonly problems: readonly string[]
}

/** The status tool's output: the same view with the unguarded agents as a count. */
export type StatusSummary = Omit<StatusView, "unguardedAgents"> & { readonly unguardedAgents: number }

/** What a status view is built from; the derived fields (`state`, `nextStep`) are computed from these. */
export type StatusFacts = Omit<StatusView, "state" | "nextStep">
