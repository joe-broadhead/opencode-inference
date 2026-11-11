import type { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, Show } from "solid-js"
import { TUI_ID, TUI_SLASH, type StatusView } from "./domain/ids.js"
import { Inference, isStatus, STATUS_TITLE, statusLines } from "./rpc.js"

interface State {
  readonly view?: StatusView
  readonly error?: string
  readonly loading: boolean
}

/** Server events that can change the status: a reload, agent rules and the OpenRouter key. Heard only while the dialog is open. */
const EVENTS = ["server.connected", "agent.updated", "integration.updated", "credential.updated", "credential.switched"] as const
const UNAVAILABLE = "STATUS_UNAVAILABLE: The Inference server part did not answer. Next step: Restart OpenCode."

/**
 * The `/inference` status dialog. It reads only the plugin's `status` RPC method and changes nothing. Keymap layers are
 * registered from setup, in global mode so the palette lists the command. No polling and no slots.
 */
export default {
  id: TUI_ID,
  setup(context) {
    const [state, setState] = createSignal<State>({ loading: true })
    const [open, setOpen] = createSignal(false)
    let closed = false
    let generation = 0
    let controller: AbortController | undefined
    const refresh = async () => {
      if (closed) return
      const current = ++generation
      controller?.abort()
      const request = (controller = new AbortController())
      setState((previous) => ({ ...previous, loading: true }))
      try {
        const view = await context.client.rpc(Inference).status({}, { location: context.location ?? context.data.location.default(), signal: request.signal })
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
            {STATUS_TITLE}
            {state().loading ? " · refreshing" : ""}
          </text>
          <Show when={state().view} fallback={<text fg={theme.text.muted}>{state().loading ? "Loading status…" : `${state().error}`}</text>}>
            {(view) => (
              <scrollbox maxHeight={28}>
                <box flexDirection="column">
                  <For each={statusLines(view(), { paste: true })}>
                    {(line) => <For each={`${line.label}: ${line.text}`.split("\n")}>{(row) => <text fg={line.ok ? theme.text.base : theme.text.feedback.warning.base}>{row}</text>}</For>}
                  </For>
                </box>
              </scrollbox>
            )}
          </Show>
          <Show when={state().view && state().error}>
            <text fg={theme.text.feedback.error.base}>{`Refresh failed: ${state().error}`}</text>
          </Show>
          <text fg={theme.text.muted} onMouseUp={() => void refresh()}>
            r refresh · esc close
          </text>
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
