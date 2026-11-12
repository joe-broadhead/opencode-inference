import { Rpc } from "@opencode/plugin/rpc"
import { ACCESS_VALUES, COMMANDS, CONNECTION_STATES, INTEGRATION_ID, INTEGRATION_NAME, MODULES, PLUGIN_ID, STATES, type Module, type StatusFacts, type StatusState, type StatusSummary, type StatusView } from "./domain/ids.js"
import { hostText } from "./host/versions.js"

// The status contract in plain JSON Schema, so the TUI bundle carries no zod. The server's zod copy
// (src/domain/status-schema.ts) validates before answering, and test/unit/status.test.ts keeps the two identical.
// Everything a status view shows is derived here, once, for the command, the RPC, the dialog and the tool.

const text = (maxLength: number) => ({ type: "string", maxLength }) as const
const choice = <const T extends readonly string[]>(values: T) => ({ type: "string", enum: values }) as const
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const
const bool = { type: "boolean" } as const
const list = <T extends object>(items: T, maxItems: number) => ({ type: "array", items, maxItems }) as const
const object = <P extends Record<string, object>, R extends readonly (keyof P & string)[]>(properties: P, required: R) =>
  ({ type: "object", properties, required, additionalProperties: false }) as const
const next = text(4096)
const module = object({ enabled: bool }, ["enabled"])
const rule = object({ action: text(128), resource: text(128), effect: choice(["allow", "ask", "deny"]) }, ["action", "resource", "effect"])

export const STATUS_JSON_SCHEMA = object(
  {
    version: text(64),
    host: object({ version: { anyOf: [text(64), { type: "null" }] }, range: text(64), tested: bool, next }, ["version", "range", "tested"]),
    state: choice(STATES),
    unguardedAgents: list(text(256), 256),
    nextStep: next,
    connection: object({ integration: { type: "string", const: INTEGRATION_ID }, state: choice(CONNECTION_STATES), required: bool, next }, ["integration", "state", "required"]),
    access: choice(ACCESS_VALUES),
    modules: object({ extractions: module, decisions: module, understanding: module }, ["extractions", "decisions", "understanding"]),
    tools: object({ registered: list(text(64), 32), planned: list(text(64), 32) }, ["registered", "planned"]),
    capabilities: object(
      { revision: text(64), reviewedOn: text(10), ageDays: count, stale: bool, basis: { type: "string", const: "documentation" }, routes: count, enabledRoutes: count },
      ["revision", "reviewedOn", "ageDays", "stale", "basis", "routes", "enabledRoutes"],
    ),
    spend: object(
      { currency: { type: "string", const: "USD" }, requestUsd: text(32), sessionUsd: text(32), rolling24hUsd: text(32), tracking: { type: "string", const: "none" } },
      ["currency", "requestUsd", "sessionUsd", "rolling24hUsd", "tracking"],
    ),
    operations: object({ tracking: { type: "string", const: "none" } }, ["tracking"]),
    permissions: object({ block: list(rule, 64) }, ["block"]),
    problems: list(text(1024), 8),
  },
  ["version", "host", "state", "unguardedAgents", "nextStep", "connection", "access", "modules", "tools", "capabilities", "spend", "operations", "permissions", "problems"],
)

/** The plugin's status RPC: one method. The TUI dialog reads it. */
export const Inference = Rpc.define({
  id: PLUGIN_ID,
  methods: { status: { input: object({}, []), output: STATUS_JSON_SCHEMA, errors: { unavailable: object({ nextStep: { type: "string" } }, ["nextStep"]) } } },
  events: {},
})

/** JSON Schema outputs reach clients unchecked, so the TUI confirms the fields it reads. */
export function isStatus(value: unknown): value is StatusView {
  if (typeof value !== "object" || value === null) return false
  const fields = new Map(Object.entries(value))
  const strings = new Set(["version", "state", "nextStep", "access"])
  return STATUS_JSON_SCHEMA.required.every((key) => {
    const field = fields.get(key)
    return strings.has(key) ? typeof field === "string" : typeof field === "object" && field !== null
  })
}

export const STATUS_TITLE = "Inference status"
export const NOTHING_TO_DO = "Nothing to do."

/** The fix for agents without the default rules: one fixed sentence, the same shape in every plugin of this family. */
export const AGENT_FIX = `Put the default rules shown by /${COMMANDS.status} first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Inference tools.`

/** The single next step: the first item that needs the user. The key drives it only once a route would use it. */
export function nextStep(facts: StatusFacts) {
  return (
    facts.host.next ??
    facts.problems[0] ??
    (facts.unguardedAgents.length ? AGENT_FIX : undefined) ??
    (facts.connection.required && facts.connection.state !== "connected" ? facts.connection.next : undefined) ??
    NOTHING_TO_DO
  )
}

function stateOf(facts: StatusFacts): StatusState {
  if (MODULES.every((name) => !facts.modules[name].enabled)) return "disabled"
  if (!facts.connection.required) return "local_only"
  return facts.connection.state === "connected" ? "ready" : "sign_in_required"
}

/** The view with its derived fields. The command, the RPC, the dialog and the tool all start here. */
export const completeStatus = (facts: StatusFacts): StatusView => {
  const { version, host, unguardedAgents, ...rest } = facts
  return { version, host, state: stateOf(facts), unguardedAgents, nextStep: nextStep(facts), ...rest }
}

/** One row: a label and its text. `ok` is false when the row needs the user. */
export interface StatusLine {
  readonly label: string
  readonly text: string
  readonly ok: boolean
}
const line = (label: string, text: string, ok: boolean): StatusLine => ({ label, text, ok })

export const rulesToPaste = (view: Pick<StatusView, "permissions">) => {
  const block = view.permissions.block
  return ["[", ...block.map((item, index) => `  ${JSON.stringify(item)}${index < block.length - 1 ? "," : ""}`), "]"].join("\n")
}

const MODULE_TEXT: { readonly [M in Module]: string } = { extractions: "Extractions", decisions: "Decisions", understanding: "Reading" }
/** The tool each module enables, to tell an implemented module from a reserved one. */
const MODULE_TOOL: { readonly [M in Module]: string } = { extractions: "inference_extract", decisions: "inference_decide", understanding: "inference_read" }
const CONNECTION_TEXT = {
  connected: "connected (OpenRouter key)",
  not_connected: "not connected",
  needs_auth: "sign-in required (OpenRouter did not accept the key)",
  unknown: "unknown",
} as const

/**
 * Every row in the family order, ending with exactly one Next step: Connection, Account, Access, the modules, Tools,
 * Agents without default rules (with the block when `paste`), OpenCode, Next step. `agents` replaces the agents row's
 * text for the compact tool output.
 */
export function statusLines(view: StatusView, { paste, agents }: { readonly paste: boolean; readonly agents?: string }): StatusLine[] {
  const unguarded = view.unguardedAgents
  const caps = view.capabilities
  return [
    line(
      "Connection",
      `${CONNECTION_TEXT[view.connection.state]}${view.connection.required ? "" : `; not needed yet: no enabled route sends (${INTEGRATION_NAME} in /connect)`}`,
      !view.connection.required || view.connection.state === "connected",
    ),
    line("Account", "the key's own OpenRouter account; Inference never reads it in this version", true),
    line("Access", `${view.access}. Reads always run; sends ${view.access === "all" ? "run" : view.access === "ask-changes" ? "ask first" : "are denied"}`, true),
    ...MODULES.map((name) => line(MODULE_TEXT[name], view.modules[name].enabled ? (view.tools.registered.includes(MODULE_TOOL[name]) ? "on" : "on (not implemented in this version)") : "off", true)),
    line("Capabilities", `${caps.basis}-derived fixture ${caps.revision}, reviewed ${caps.reviewedOn} (${caps.ageDays} days ago${caps.stale ? ", stale" : ""}); ${caps.enabledRoutes} of ${caps.routes} routes enabled`, !caps.stale),
    line("Spend", `limits ${view.spend.requestUsd} per request, ${view.spend.sessionUsd} per session, ${view.spend.rolling24hUsd} per 24 hours (USD); nothing is tracked because nothing is sent`, true),
    line("Tools", `${view.tools.registered.length} registered (${view.tools.registered.join(", ")}); planned: ${view.tools.planned.join(", ")}`, true),
    ...view.problems.map((problem) => line("Problem", problem, false)),
    line("Agents without default rules", agents ?? (unguarded.length ? `${unguarded.join(", ")}${paste ? `\n${rulesToPaste(view)}` : ""}` : "none"), agents ? agents === "none" : unguarded.length === 0),
    line("OpenCode", `${hostText(view.host)}. Inference ${view.version}`, view.host.tested),
    line("Next step", view.nextStep, view.nextStep === NOTHING_TO_DO),
  ]
}

const render = (lines: readonly StatusLine[]) => [STATUS_TITLE, ...lines.map((item) => `${item.label}: ${item.text}`)].join("\n")

/** `/inference-status`: every row, the block for agents without default rules, and the next step. */
export const formatStatus = (view: StatusView) => render(statusLines(view, { paste: true }))

/** The status tool's output: the same view with the unguarded agents as a count. */
export const compactStatus = (view: StatusView): StatusSummary => ({ ...view, unguardedAgents: view.unguardedAgents.length })

export function formatSummary(summary: StatusSummary) {
  const view: StatusView = { ...summary, unguardedAgents: [] }
  return render(statusLines(view, { paste: false, agents: summary.unguardedAgents ? `${summary.unguardedAgents}` : "none" }))
}
