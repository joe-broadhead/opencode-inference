import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { InferenceError } from "../../src/domain/errors.js"
import type { ToolSpec } from "../../src/domain/registry.js"
import { createDispatcher, type Handler } from "../../src/runtime/dispatch.js"

const LOCAL = { network: false, uploadsSource: false, billable: false, readsFiles: false }
const echo: ToolSpec = { name: "echo", class: "read", effects: LOCAL, description: "Echoes.", input: z.strictObject({ value: z.string().max(8) }), output: z.strictObject({ value: z.string() }) }
const call = (signal = new AbortController().signal) => ({ sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal })

describe("the dispatcher", () => {
  test("parses input strictly and names paths, never values", async () => {
    const run = createDispatcher({ tools: [echo], handlers: { echo: (async (input: { value: string }) => ({ output: input, text: input.value })) as Handler }, unavailable: () => undefined })
    expect(await run("echo", { value: "hi" }, call())).toEqual({ output: { value: "hi" }, text: "hi" })
    const secret = "SECRET-VALUE-123"
    const error = await run("echo", { value: secret }, call()).catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(InferenceError)
    expect((error as Error).message).toMatch(/^INPUT_INVALID: The tool input is invalid: value: .*Next step:/)
    expect((error as Error).message).not.toContain(secret)
    await expect(run("echo", { value: "x", extra: true }, call())).rejects.toThrow(/unknown keys "extra"/)
  })

  test("re-checks availability on every call: a tool that becomes unavailable after discovery is refused at execution", async () => {
    let available = true
    let ran = 0
    const run = createDispatcher({
      tools: [echo],
      handlers: { echo: (async (input: { value: string }) => (ran++, { output: input, text: "" })) as Handler },
      unavailable: () => (available ? undefined : new InferenceError("MODULE_DISABLED")),
    })
    await run("echo", { value: "a" }, call())
    available = false
    await expect(run("echo", { value: "a" }, call())).rejects.toThrow(/^MODULE_DISABLED:/)
    expect(ran).toBe(1)
  })

  test("refuses a cancelled call before and after the handler", async () => {
    const controller = new AbortController()
    controller.abort()
    let ran = 0
    const handlers = { echo: (async (input: { value: string }) => (ran++, { output: input, text: "" })) as Handler }
    const run = createDispatcher({ tools: [echo], handlers, unavailable: () => undefined })
    await expect(run("echo", { value: "a" }, call(controller.signal))).rejects.toThrow(/^CANCELLED:/)
    expect(ran).toBe(0)
    const late = new AbortController()
    const slow = createDispatcher({ tools: [echo], handlers: { echo: (async (input: { value: string }) => (late.abort(), { output: input, text: "" })) as Handler }, unavailable: () => undefined })
    await expect(slow("echo", { value: "a" }, call(late.signal))).rejects.toThrow(/^CANCELLED:/)
  })

  test("validates the handler's output against the tool's own schema", async () => {
    const run = createDispatcher({ tools: [echo], handlers: { echo: (async () => ({ output: { value: 1 }, text: "" })) as Handler }, unavailable: () => undefined })
    await expect(run("echo", { value: "a" }, call())).rejects.toThrow(/^OUTPUT_INVALID:/)
  })

  test("refuses a name that is not registered, such as a planned tool", async () => {
    const run = createDispatcher({ tools: [echo], handlers: {}, unavailable: () => undefined })
    await expect(run("extract", {}, call())).rejects.toThrow(/^TOOL_UNAVAILABLE: There is no Inference tool named "extract"/)
  })
})
