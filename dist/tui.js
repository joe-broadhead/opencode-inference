// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Rpc } from "@opencode/plugin/rpc";
import { createSignal, For, Show } from "solid-js";

// src/domain/ids.ts
var PLUGIN_NAME = "inference";
var TUI_ID = "inference.tui";
var TUI_SLASH = "inference";

// src/status-text.ts
var STATE_TEXT = {
  ready: "ready",
  needs_sign_in: "needs sign-in",
  error: "error"
};
function accountsText(view) {
  if (view.accounts.length === 0) return "none: this plugin signs in to nothing";
  return view.accounts.map((account) => `${account.alias} ${STATE_TEXT[account.state] ?? account.state}${account.reason === void 0 ? "" : ` (${account.reason})`}`).join("; ");
}
function statusText(view) {
  return [
    `Inference ${view.version} status: ${STATE_TEXT[view.state] ?? view.state}`,
    `OpenCode: ${view.host.version} (supported ${view.host.range}; tested ${view.host.tested.join(", ")})`,
    `Accounts: ${accountsText(view)}`,
    `Agents without the generated rules: ${view.unguardedAgents.length === 0 ? "none" : view.unguardedAgents.join(", ")}`,
    `Next step: ${view.nextStep ?? "none"}`
  ].join("\n");
}

// src/tui.tsx
var text = (maxLength) => ({
  type: "string",
  maxLength
});
var STATUS_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: text(64),
    version: text(64),
    host: {
      type: "object",
      properties: {
        version: text(64),
        range: text(64),
        tested: {
          type: "array",
          items: text(64),
          minItems: 1
        }
      },
      required: ["version", "range", "tested"],
      additionalProperties: false
    },
    state: {
      type: "string",
      enum: ["ready", "needs_sign_in", "error"]
    },
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          alias: text(64),
          state: {
            type: "string",
            enum: ["ready", "needs_sign_in", "error"]
          },
          owner: {
            type: "object",
            additionalProperties: true
          },
          reason: text(160)
        },
        required: ["alias", "state"],
        additionalProperties: false
      }
    },
    unguardedAgents: {
      type: "array",
      items: text(64)
    },
    nextStep: {
      anyOf: [text(200), {
        type: "null"
      }]
    }
  },
  required: ["name", "version", "host", "state", "accounts", "unguardedAgents", "nextStep"],
  additionalProperties: false
};
var ENVELOPE = {
  type: "object",
  properties: {
    sessionID: text(128),
    input: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  required: ["sessionID", "input"],
  additionalProperties: false
};
var STATUS_RPC = Rpc.define({
  id: PLUGIN_NAME,
  methods: {
    status: {
      input: ENVELOPE,
      output: STATUS_JSON_SCHEMA,
      errors: {
        failed: {
          type: "object",
          properties: {
            code: text(64),
            next: text(400)
          },
          required: ["code", "next"],
          additionalProperties: false
        }
      }
    }
  },
  events: {}
});
function isStatus(value) {
  if (typeof value !== "object" || value === null) return false;
  const fields = value;
  return typeof fields["version"] === "string" && typeof fields["state"] === "string" && typeof fields["host"] === "object" && Array.isArray(fields["accounts"]) && Array.isArray(fields["unguardedAgents"]);
}
var UNAVAILABLE = "STATUS_UNAVAILABLE: The Inference server part did not answer. Next step: Restart OpenCode.";
var NO_SESSION = "STATUS_UNAVAILABLE: Open a session first: the status RPC runs under its rules. Next step: Open a session, then reopen this dialog.";
var EVENTS = ["server.connected", "agent.updated", "integration.updated", "credential.updated", "credential.switched"];
var tui_default = {
  id: TUI_ID,
  setup(context) {
    const [state, setState] = createSignal({
      loading: true
    });
    const [open, setOpen] = createSignal(false);
    let closed = false;
    let generation = 0;
    let controller;
    const sessionID = () => context.ui.tabs.list().find((tab) => tab.active)?.sessionID ?? context.data.session.list()[0]?.id;
    const refresh = async () => {
      if (closed) return;
      const current = ++generation;
      controller?.abort();
      const request = controller = new AbortController();
      setState((previous) => ({
        ...previous,
        loading: true
      }));
      const id = sessionID();
      if (id === void 0) {
        setState({
          loading: false,
          error: NO_SESSION
        });
        return;
      }
      try {
        const view = await context.client.rpc(STATUS_RPC).status({
          sessionID: id,
          input: {}
        }, {
          location: context.location ?? context.data.location.default(),
          signal: request.signal
        });
        if (closed || current !== generation) return;
        if (!isStatus(view)) throw new Error("STATUS_UNAVAILABLE: The Inference server answered with an unexpected status. Next step: Restart OpenCode.");
        setState({
          view,
          loading: false
        });
      } catch (error) {
        if (!closed && current === generation) setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error && error.message ? error.message : UNAVAILABLE
        }));
      }
    };
    const View = () => {
      const theme = context.theme;
      return (() => {
        var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createTextNode(`Inference status`), _el$5 = _$createElement("text");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$5);
        _$setProp(_el$, "flexDirection", "column");
        _$setProp(_el$, "paddingLeft", 2);
        _$setProp(_el$, "paddingRight", 2);
        _$setProp(_el$, "paddingBottom", 1);
        _$setProp(_el$, "gap", 1);
        _$insertNode(_el$2, _el$3);
        _$insert(_el$2, () => state().loading ? " \xB7 refreshing" : "", null);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return state().view;
          },
          get fallback() {
            return (() => {
              var _el$7 = _$createElement("text");
              _$insert(_el$7, (() => {
                var _c$ = _$memo(() => !!state().loading);
                return () => _c$() ? "Loading status\u2026" : `${state().error}`;
              })());
              _$effect((_$p) => _$setProp(_el$7, "fg", theme.text.muted, _$p));
              return _el$7;
            })();
          },
          children: (view) => (() => {
            var _el$8 = _$createElement("scrollbox"), _el$9 = _$createElement("box");
            _$insertNode(_el$8, _el$9);
            _$setProp(_el$8, "maxHeight", 28);
            _$setProp(_el$9, "flexDirection", "column");
            _$insert(_el$9, _$createComponent(For, {
              get each() {
                return statusText(view()).split("\n");
              },
              children: (line) => (() => {
                var _el$0 = _$createElement("text");
                _$insert(_el$0, line);
                _$effect((_$p) => _$setProp(_el$0, "fg", theme.text.base, _$p));
                return _el$0;
              })()
            }));
            return _el$8;
          })()
        }), _el$5);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!state().view)() && state().error;
          },
          get children() {
            var _el$4 = _$createElement("text");
            _$insert(_el$4, () => `Refresh failed: ${state().error}`);
            _$effect((_$p) => _$setProp(_el$4, "fg", theme.text.feedback.error.base, _$p));
            return _el$4;
          }
        }), _el$5);
        _$insertNode(_el$5, _$createTextNode(`r refresh \xB7 esc close`));
        _$setProp(_el$5, "onMouseUp", () => void refresh());
        _$effect((_p$) => {
          var _v$ = theme.text.base, _v$2 = theme.text.muted;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
          return _p$;
        }, {
          e: void 0,
          t: void 0
        });
        return _el$;
      })();
    };
    let stops = [];
    const unsubscribe = () => {
      for (const stop of stops.splice(0)) stop();
    };
    const show = () => {
      if (closed) return;
      setOpen(true);
      unsubscribe();
      stops = EVENTS.map((type) => context.data.on(type, () => void refresh()));
      context.ui.dialog.show(() => _$createComponent(View, {}), () => {
        unsubscribe();
        setOpen(false);
      });
      context.ui.dialog.set({
        size: "large"
      });
      void refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "inference.status",
        title: "Inference: Status",
        group: "Inference",
        palette: true,
        slash: {
          name: TUI_SLASH
        },
        run: show
      }, {
        id: "inference.refresh",
        title: "Refresh Inference status",
        group: "Inference",
        bind: "r",
        enabled: () => open(),
        run: () => void refresh()
      }]
    }));
    return () => {
      closed = true;
      generation++;
      controller?.abort();
      unsubscribe();
      if (open()) context.ui.dialog.clear();
    };
  }
};
export {
  tui_default as default
};
