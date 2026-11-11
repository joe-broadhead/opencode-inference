import type * as z from "zod"
import { fence, InferenceError } from "../domain/errors.js"
import type { ToolSpec } from "../domain/registry.js"

// The one dispatcher. The model's tools and the tools RPC methods both call `runTool`, so every check below runs on
// both paths: the plugin is open, the tool is available NOW (describe-time availability is never the guard), the input
// parses strictly, the call was not cancelled, and the output matches the tool's own schema.
//
// PR 2 inserts its steps here, between the input parse and the handler, in the order of handoff §7: source
// authorization and snapshot, route revalidation, effect assertion, budget reservation and the dispatch record, then
// settlement after the handler. Read-class local tools need none of them.

/** The call a tool runs as: the model's tool context or the tools RPC's script call. */
export interface Invocation {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

/** A tool's result: structured output for Code Mode and scripts, and short text for people. */
export interface ToolResult {
  readonly output: unknown
  readonly text: string
}

export type Handler = (input: never, invocation: Invocation) => Promise<ToolResult>

export interface DispatcherOptions {
  readonly tools: readonly ToolSpec[]
  readonly handlers: Readonly<Record<string, Handler>>
  /** Why a tool cannot run at this moment, or undefined when it can. Called on every call. */
  readonly unavailable: (tool: ToolSpec) => InferenceError | undefined
}

/** Strict input parsing: the message names each offending path and rule, never a value. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const problems = parsed.error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "input"
    return issue.code === "unrecognized_keys" ? `${path}: unknown keys ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}` : `${path}: ${issue.message}`
  })
  throw new InferenceError("INPUT_INVALID", `The tool input is invalid: ${problems.join("; ")}.`)
}

export type RunTool = (name: string, input: unknown, invocation: Invocation) => Promise<ToolResult>

export function createDispatcher(options: DispatcherOptions): RunTool {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))
  return async (name, raw, invocation) => {
    const tool = byName.get(name)
    const handler = options.handlers[name]
    if (!tool || !handler) throw new InferenceError("TOOL_UNAVAILABLE", `There is no Inference tool named ${JSON.stringify(name)} in this version.`)
    fence(invocation.signal)
    const blocked = options.unavailable(tool)
    if (blocked) throw blocked
    const input = parseInput(tool.input, raw)
    const result = await handler(input as never, invocation)
    fence(invocation.signal)
    const checked = tool.output.safeParse(result.output)
    if (!checked.success) throw new InferenceError("OUTPUT_INVALID", `inference_${name} produced a result that does not match its own schema.`)
    return { output: checked.data, text: result.text }
  }
}
