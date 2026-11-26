// Stable names and the zod-free shared vocabulary. The TUI bundle imports this file, so it imports nothing.

/** The plugin's one name: the tool namespace, the RPC id and the prefix of every permission action (contract §3). */
export const PLUGIN_NAME = "inference"
/** The TUI plugin's id and its slash command. */
export const TUI_ID = "inference.tui"
export const TUI_SLASH = "inference"
/** The status command and its one-line description. */
export const COMMAND = "inference"
export const COMMAND_DESCRIPTION = "Inference status: OpenCode's host range, every account alias and the next step"

/**
 * Modules: the operations a later release implements, each switched by `modules.<name>`. `understanding` is reserved:
 * it has no method in this version, so `capabilities` and `plan` describe it and nothing registers it.
 */
export const MODULES = ["extractions", "decisions", "understanding"] as const
export type Module = (typeof MODULES)[number]
export const IMPLEMENTED_MODULES: readonly Module[] = ["extractions", "decisions"]
