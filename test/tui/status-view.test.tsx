// Mounts the compiled dist/tui.js (run `npm run build` first) with the OpenTUI 0.8 test renderer, the way
// OpenCode's TUI does: the Solid plugin swaps solid-js's server build for the client build.
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/tui"
import type { StatusView } from "../../src/domain/ids.js"
import { AGENT_FIX } from "../../src/rpc.js"

const VERSION = "0.0.0-test"

ensureSolidTransformPlugin()
const dist = new URL("../../dist/tui.js", import.meta.url)
if (!existsSync(dist)) throw new Error("dist/tui.js is missing: run npm run build first")
const { testRender } = await import("@opentui/solid")
const { default: tui } = (await import(dist.href)) as { default: Plugin.Definition }

type Context = Parameters<Plugin.Definition["setup"]>[0]
type Command = { id?: string; title?: string; bind?: string; slash?: { name: string }; palette?: boolean; enabled?: () => boolean; run: () => unknown }
interface Deferred { resolve(view: StatusView): void; reject(error: Error): void; signal: AbortSignal }

const view = (version: string, overrides: Partial<StatusView> = {}): StatusView => ({
  version,
  host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true },
  state: "local_only",
  unguardedAgents: ["reviewer"],
  nextStep: AGENT_FIX,
  connection: { integration: "inference-openrouter", state: "not_connected", required: false, next: "Run /connect and choose OpenRouter for Inference, then enter an OpenRouter API key." },
  access: "ask-changes",
  modules: { extractions: { enabled: true }, decisions: { enabled: true }, understanding: { enabled: false } },
  tools: { registered: ["inference_status", "inference_capabilities", "inference_plan"], planned: ["inference_extract", "inference_decide", "inference_read"] },
  capabilities: { revision: "openrouter-2026-11-11.1", reviewedOn: "2026-11-11", ageDays: 1, stale: false, basis: "documentation", routes: 5, enabledRoutes: 0 },
  spend: { currency: "USD", requestUsd: null, sessionUsd: null, rolling24hUsd: null, tracking: "none" },
  operations: { tracking: "none" },
  permissions: { block: [{ action: "inference_*", resource: "*", effect: "ask" }, { action: "inference_status", resource: "*", effect: "allow" }] },
  problems: [],
  ...overrides,
})

/** A narrow fake of the TUI context: only what the view touches. */
function fakeContext() {
  const requests: Deferred[] = []
  const layers: (() => { mode?: string; commands?: readonly Command[] })[] = []
  const events = new Map<string, () => void>(), stopped: string[] = []
  const dialog = { render: undefined as (() => unknown) | undefined, onClose: undefined as (() => void) | undefined, cleared: 0, size: undefined as string | undefined }
  const context = {
    location: { directory: "/project" },
    data: {
      location: { default: () => ({ directory: "/default" }) },
      on: (type: string, handler: () => void) => { events.set(type, handler); return () => { stopped.push(type); events.delete(type) } },
    },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: { warning: { base: "#ffaa00" }, error: { base: "#ff0000" } } } },
    client: {
      rpc: () => ({
        status: (input: object, options: { signal: AbortSignal; location: unknown }) => {
          expect(input).toEqual({})
          expect(options.location).toEqual({ directory: "/project" })
          return new Promise<StatusView>((resolve, reject) => requests.push({ resolve, reject, signal: options.signal }))
        },
      }),
    },
    keymap: { layer: (factory: () => { commands?: readonly Command[] }) => { layers.push(factory) } },
    ui: {
      dialog: {
        show: (render: () => unknown, onClose: () => void) => { dialog.render = render; dialog.onClose = onClose },
        set: (options: { size?: string }) => { dialog.size = options.size },
        clear: () => { dialog.cleared++; const close = dialog.onClose; dialog.render = dialog.onClose = undefined; close?.() },
      },
    },
  } satisfies Partial<Record<keyof Context, unknown>>
  const command = (id: string) => layers.flatMap(layer => layer().commands ?? []).find(c => c.id === id)
  return { context: context as unknown as Context, requests, layers, events, stopped, dialog, command }
}

const destroys: (() => void)[] = []
afterEach(() => { for (const destroy of destroys.splice(0)) destroy() })
async function mount(render: () => unknown) {
  const screen = await testRender(() => render() as never, { width: 110, height: 40 })
  destroys.push(() => screen.renderer.destroy())
  return async () => { await Bun.sleep(0); await screen.renderOnce(); return screen.captureCharFrame() }
}
async function start() {
  const fake = fakeContext()
  const cleanup = (await tui.setup(fake.context)) as () => void
  expect(tui.id).toBe("inference.core.tui")
  return { ...fake, cleanup }
}
async function open() {
  const ui = await start()
  ui.command("inference.status")!.run()
  return { ...ui, frame: await mount(ui.dialog.render!) }
}

test("the status command is a global palette and slash command registered from setup", async () => {
  const ui = await start()
  expect(ui.layers.map(layer => layer().mode)).toEqual(["global"])
  expect(ui.command("inference.status")).toMatchObject({ title: "Inference: Status", palette: true, slash: { name: "inference" } })
  expect(ui.command("inference.refresh")).toMatchObject({ title: "Refresh Inference status", bind: "r" })
  expect(ui.layers.flatMap(layer => layer().commands ?? []).filter(c => c.palette).map(c => c.id)).toEqual(["inference.status"])
  expect(ui.requests).toHaveLength(0) // nothing is read until the dialog opens
  expect(ui.command("inference.refresh")!.enabled!()).toBe(false)
  ui.command("inference.status")!.run()
  expect(ui.dialog.size).toBe("large")
  expect(ui.command("inference.refresh")!.enabled!()).toBe(true)
  ui.context.ui.dialog.clear()
  expect(ui.command("inference.refresh")!.enabled!()).toBe(false)
})

test("renders the status lines and the next steps from the status RPC", async () => {
  const ui = await open()
  expect(await ui.frame()).toContain("Loading status")
  ui.requests[0]!.resolve(view(VERSION))
  const frame = await ui.frame()
  const lines = [
    "Inference status",
    "Connection: not connected; not needed yet",
    "Account: the key's own OpenRouter account",
    "Access: ask-changes. Reads always run; sends ask first",
    "Extractions: on (not implemented in this version)",
    "Reading: off",
    "Capabilities: documentation-derived fixture openrouter-2026-11-11.1",
    "Tools: 3 registered",
    "Agents without default rules: reviewer",
    "  {\"action\":\"inference_*\",\"resource\":\"*\",\"effect\":\"ask\"},",
    `OpenCode: 2.2.3 (tested). Inference ${VERSION}`,
    "Next step: Put the default rules shown by /inference-status first",
    "r refresh · esc close",
  ]
  for (const line of lines) expect(frame).toContain(line)
  // The family order: Connection, Account, Access, the modules, Tools, agents, OpenCode, then the one next step.
  const at = lines.map(line => frame.indexOf(line))
  expect(at).toEqual([...at].sort((a, b) => a - b))
  expect(frame.match(/Next step:/g)).toHaveLength(1)
})

test("refresh re-reads the RPC and drops a stale answer", async () => {
  const ui = await open()
  ui.requests[0]!.resolve(view(VERSION))
  expect(await ui.frame()).toContain(`Inference ${VERSION}`)
  ui.command("inference.refresh")!.run()
  ui.command("inference.refresh")!.run()
  expect(ui.requests).toHaveLength(3)
  expect(ui.requests[1]!.signal.aborted).toBe(true)
  ui.requests[2]!.resolve(view("fresh"))
  ui.requests[1]!.resolve(view("stale"))
  const frame = await ui.frame()
  expect(frame).toContain("Inference fresh")
  expect(frame).not.toContain("stale")
})

test("a failed refresh keeps the last status and says why", async () => {
  const ui = await open()
  ui.requests[0]!.resolve(view(VERSION))
  await ui.frame()
  ui.command("inference.refresh")!.run()
  ui.requests[1]!.reject(new Error("Inference status is unavailable"))
  const frame = await ui.frame()
  expect(frame).toContain(`Inference ${VERSION}`)
  expect(frame).toContain("Refresh failed: Inference status is unavailable")
})

test("the dialog subscribes to server events only while it is open", async () => {
  const ui = await start()
  const events = ["server.connected", "agent.updated", "integration.updated", "credential.updated", "credential.switched"]
  expect(ui.events.size).toBe(0)
  ui.command("inference.status")!.run()
  expect([...ui.events.keys()].sort()).toEqual([...events].sort())
  expect(ui.requests).toHaveLength(1)
  for (const type of events) ui.events.get(type)!()
  expect(ui.requests).toHaveLength(1 + events.length)
  ui.context.ui.dialog.clear()
  expect(ui.events.size).toBe(0)
  expect(ui.stopped.sort()).toEqual([...events].sort())
})

test("dispose closes the dialog, aborts the request in flight, removes the listeners, and ignores late answers", async () => {
  const ui = await open()
  const pending = ui.requests[0]!
  ui.cleanup()
  expect(ui.dialog.cleared).toBe(1)
  expect(pending.signal.aborted).toBe(true)
  expect(ui.events.size).toBe(0)
  expect(ui.stopped).toHaveLength(5)
  pending.resolve(view("late"))
  ui.command("inference.status")!.run()
  expect(ui.events.size).toBe(0)
  expect(ui.dialog.render).toBeUndefined()
  expect(ui.requests).toHaveLength(1)
})
