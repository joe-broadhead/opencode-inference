import type { Plugin } from "@opencode/plugin/tui"
import { Rpc } from "@opencode/plugin/rpc"
import { createSignal, For, Show } from "solid-js"
import { PLUGIN_NAME, TUI_ID, TUI_SLASH } from "./domain/ids.js"
import { statusText, type StatusView } from "./status-text.js"

// The `/inference` status dialog. It reads only the plugin's `status` RPC method, run under an open session's rules,
// and changes nothing. Keymap layers are registered from setup, in global mode so the palette lists the command. No
// polling and no slots.

const text = (maxLength: number) => ({ type: "string", maxLength }) as const
const STATUS_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: text(64),
    version: text(64),
    host: {
      type: "object",
      properties: { version: text(64), range: text(64), tested: { type: "array", items: text(64), minItems: 1 } },
      required: ["version", "range", "tested"],
      additionalProperties: false,
    },
    state: { type: "string", enum: ["ready", "needs_sign_in", "error"] },
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: { alias: text(64), state: { type: "string", enum: ["ready", "needs_sign_in", "error"] }, owner: { type: "object", additionalProperties: true }, reason: text(160) },
        required: ["alias", "state"],
        additionalProperties: false,
      },
    },
    unguardedAgents: { type: "array", items: text(64) },
    nextStep: { anyOf: [text(200), { type: "null" }] },
  },
  required: ["name", "version", "host", "state", "accounts", "unguardedAgents", "nextStep"],
  additionalProperties: false,
} as const

/** The contract RPC's envelope: the session the call runs as, and the method's own input. */
const ENVELOPE = {
  type: "object",
  properties: { sessionID: text(128), input: { type: "object", properties: {}, additionalProperties: false } },
  required: ["sessionID", "input"],
  additionalProperties: false,
} as const

const STATUS_RPC = Rpc.define({
  id: PLUGIN_NAME,
  methods: {
    status: {
      input: ENVELOPE,
      output: STATUS_JSON_SCHEMA,
      errors: { failed: { type: "object", properties: { code: text(64), next: text(400) }, required: ["code", "next"], additionalProperties: false } },
    },
  },
  events: {},
})

/** JSON Schema outputs reach clients unchecked, so the dialog confirms the fields it reads. */
function isStatus(value: unknown): value is StatusView {
  if (typeof value !== "object" || value === null) return false
  const fields = value as Record<string, unknown>
  return (
    typeof fields["version"] === "string" &&
    typeof fields["state"] === "string" &&
    typeof fields["host"] === "object" &&
    Array.isArray(fields["accounts"]) &&
    Array.isArray(fields["unguardedAgents"])
  )
}

const UNAVAILABLE = "STATUS_UNAVAILABLE: The Inference server part did not answer. Next step: Restart OpenCode."
const NO_SESSION = "STATUS_UNAVAILABLE: Open a session first: the status RPC runs under its rules. Next step: Open a session, then reopen this dialog."

interface State {
  readonly view?: StatusView
  readonly error?: string
  readonly loading: boolean
}

/** Server events that can change the status: a reload and an account sign-in. Heard only while the dialog is open. */
const EVENTS = ["server.connected", "agent.updated", "integration.updated", "credential.updated", "credential.switched"] as const

export default {
  id: TUI_ID,
  setup(context) {
    const [state, setState] = createSignal<State>({ loading: true })
    const [open, setOpen] = createSignal(false)
    let closed = false
    let generation = 0
    let controller: AbortController | undefined
    const sessionID = () => context.ui.tabs.list().find((tab) => tab.active)?.sessionID ?? context.data.session.list()[0]?.id
    const refresh = async () => {
      if (closed) return
      const current = ++generation
      controller?.abort()
      controller = new AbortController()
      const request = controller
      setState((previous) => ({ ...previous, loading: true }))
      const id = sessionID()
      if (id === undefined) {
        setState({ loading: false, error: NO_SESSION })
        return
      }
      try {
        const view = await context.client.rpc(STATUS_RPC).status({ sessionID: id, input: {} }, { location: context.location ?? context.data.location.default(), signal: request.signal })
        if (closed || current !== generation) return
        if (!isStatus(view)) throw new Error("STATUS_UNAVAILABLE: The Inference server answered with an unexpected status. Next step: Restart OpenCode.")
        setState({ view, loading: false })
      } catch (error) {
        if (!closed && current === generation) setState((previous) => ({ ...previous, loading: false, error: error instanceof Error && error.message ? error.message : UNAVAILABLE }))
      }
    }
    const View = () => {
      const theme = context.theme
      return (
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
          <text fg={theme.text.base}>
            Inference status
            {state().loading ? " · refreshing" : ""}
          </text>
          <Show when={state().view} fallback={<text fg={theme.text.muted}>{state().loading ? "Loading status…" : `${state().error}`}</text>}>
            {(view) => (
              <scrollbox maxHeight={28}>
                <box flexDirection="column">
                  <For each={statusText(view()).split("\n")}>{(line) => <text fg={theme.text.base}>{line}</text>}</For>
                </box>
              </scrollbox>
            )}
          </Show>
          <Show when={state().view && state().error}>
            <text fg={theme.text.feedback.error.base}>{`Refresh failed: ${state().error}`}</text>
          </Show>
          <text fg={theme.text.muted}>r refresh · esc close</text>
        </box>
      )
    }
    let stops: (() => void)[] = []
    const unsubscribe = () => {
      for (const stop of stops.splice(0)) stop()
    }
    const show = () => {
      if (closed) return
      setOpen(true)
      unsubscribe()
      stops = EVENTS.map((type) => context.data.on(type, () => void refresh()))
      context.ui.dialog.show(
        () => <View />,
        () => {
          unsubscribe()
          setOpen(false)
        },
      )
      context.ui.dialog.set({ size: "large" })
      void refresh()
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "inference.status", title: "Inference: Status", group: "Inference", palette: true, slash: { name: TUI_SLASH }, run: show },
        { id: "inference.refresh", title: "Refresh Inference status", group: "Inference", bind: "r", enabled: () => open(), run: () => void refresh() },
      ],
    }))
    return () => {
      closed = true
      generation++
      controller?.abort()
      unsubscribe()
      if (open()) context.ui.dialog.clear()
    }
  },
} satisfies Plugin.Definition
