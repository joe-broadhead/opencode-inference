// src/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createSignal, For, Show } from "solid-js";

// src/domain/ids.ts
var PLUGIN_ID = "inference.core";
var TUI_ID = "inference.core.tui";
var NAMESPACE = "inference";
var PERMISSION_PREFIX = `${NAMESPACE}_`;
var NAMESPACE_ACTION = `${NAMESPACE}_*`;
var COMMANDS = { status: "inference-status" };
var TUI_SLASH = "inference";
var INTEGRATION_ID = "inference-openrouter";
var INTEGRATION_NAME = "OpenRouter for Inference";
var ACCESS_VALUES = ["all", "ask-changes", "read-only"];
var MODULES = ["extractions", "decisions", "understanding"];
var STATES = ["ready", "local_only", "sign_in_required", "disabled"];
var CONNECTION_STATES = ["connected", "not_connected", "needs_auth", "unknown"];

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";

// src/host/versions.ts
var HOST_RANGE = ">=2.2.3 <2.3.0";
var parse = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : void 0;
};
var compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function inRange(version, range = HOST_RANGE) {
  const [, low, high] = /^>=(\S+) <(\S+)$/.exec(range) ?? [];
  const found = parse(version);
  const min = low && parse(low);
  const max = high && parse(high);
  if (!found || !min || !max) return false;
  return compare(found, min) >= 0 && compare(found, max) < 0;
}
var hostText = (host) => host.tested ? `${host.version} (tested)` : host.version !== null && inRange(host.version, host.range) ? `${host.version} (untested; supported range ${host.range})` : `${host.version ?? "unknown"} (outside ${host.range}; allowUntestedHost is set)`;

// src/rpc.ts
var text = (maxLength) => ({ type: "string", maxLength });
var choice = (values) => ({ type: "string", enum: values });
var count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
var bool = { type: "boolean" };
var list = (items, maxItems) => ({ type: "array", items, maxItems });
var object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var next = text(4096);
var module = object({ enabled: bool }, ["enabled"]);
var rule = object({ action: text(128), resource: text(128), effect: choice(["allow", "ask", "deny"]) }, ["action", "resource", "effect"]);
var STATUS_JSON_SCHEMA = object(
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
      ["revision", "reviewedOn", "ageDays", "stale", "basis", "routes", "enabledRoutes"]
    ),
    spend: object(
      { currency: { type: "string", const: "USD" }, requestUsd: text(32), sessionUsd: text(32), rolling24hUsd: text(32), tracking: { type: "string", const: "none" } },
      ["currency", "requestUsd", "sessionUsd", "rolling24hUsd", "tracking"]
    ),
    operations: object({ tracking: { type: "string", const: "none" } }, ["tracking"]),
    permissions: object({ block: list(rule, 64) }, ["block"]),
    problems: list(text(1024), 8)
  },
  ["version", "host", "state", "unguardedAgents", "nextStep", "connection", "access", "modules", "tools", "capabilities", "spend", "operations", "permissions", "problems"]
);
var Inference = Rpc.define({
  id: PLUGIN_ID,
  methods: { status: { input: object({}, []), output: STATUS_JSON_SCHEMA, errors: { unavailable: object({ nextStep: { type: "string" } }, ["nextStep"]) } } },
  events: {}
});
function isStatus(value) {
  if (typeof value !== "object" || value === null) return false;
  const fields = new Map(Object.entries(value));
  const strings = /* @__PURE__ */ new Set(["version", "state", "nextStep", "access"]);
  return STATUS_JSON_SCHEMA.required.every((key) => {
    const field = fields.get(key);
    return strings.has(key) ? typeof field === "string" : typeof field === "object" && field !== null;
  });
}
var STATUS_TITLE = "Inference status";
var NOTHING_TO_DO = "Nothing to do.";
var AGENT_FIX = `Put the default rules shown by /${COMMANDS.status} first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Inference tools.`;
var line = (label, text2, ok) => ({ label, text: text2, ok });
var rulesToPaste = (view) => {
  const block = view.permissions.block;
  return ["[", ...block.map((item, index) => `  ${JSON.stringify(item)}${index < block.length - 1 ? "," : ""}`), "]"].join("\n");
};
var MODULE_TEXT = { extractions: "Extractions", decisions: "Decisions", understanding: "Reading" };
var MODULE_TOOL = { extractions: "inference_extract", decisions: "inference_decide", understanding: "inference_read" };
var CONNECTION_TEXT = {
  connected: "connected (OpenRouter key)",
  not_connected: "not connected",
  needs_auth: "sign-in required (OpenRouter did not accept the key)",
  unknown: "unknown"
};
function statusLines(view, { paste, agents }) {
  const unguarded = view.unguardedAgents;
  const caps = view.capabilities;
  return [
    line(
      "Connection",
      `${CONNECTION_TEXT[view.connection.state]}${view.connection.required ? "" : `; not needed yet: no enabled route sends (${INTEGRATION_NAME} in /connect)`}`,
      !view.connection.required || view.connection.state === "connected"
    ),
    line("Account", "the key's own OpenRouter account; Inference sends the key only with a call on an enabled route and never reads the account itself", true),
    line("Access", `${view.access}. Reads always run; sends ${view.access === "all" ? "run" : view.access === "ask-changes" ? "ask first" : "are denied"}`, true),
    ...MODULES.map((name) => line(MODULE_TEXT[name], view.modules[name].enabled ? view.tools.registered.includes(MODULE_TOOL[name]) ? "on" : "on (not implemented in this version)" : "off", true)),
    line("Capabilities", `${caps.basis}-derived fixture ${caps.revision}, reviewed ${caps.reviewedOn} (${caps.ageDays} days ago${caps.stale ? ", stale" : ""}); ${caps.enabledRoutes} of ${caps.routes} routes enabled`, !caps.stale),
    line("Spend", `limits ${view.spend.requestUsd} per request, ${view.spend.sessionUsd} per session, ${view.spend.rolling24hUsd} per 24 hours (USD); nothing is tracked because nothing is sent`, true),
    line("Tools", `${view.tools.registered.length} registered (${view.tools.registered.join(", ")}); planned: ${view.tools.planned.join(", ")}`, true),
    ...view.problems.map((problem) => line("Problem", problem, false)),
    line("Agents without default rules", agents ?? (unguarded.length ? `${unguarded.join(", ")}${paste ? `
${rulesToPaste(view)}` : ""}` : "none"), agents ? agents === "none" : unguarded.length === 0),
    line("OpenCode", `${hostText(view.host)}. Inference ${view.version}`, view.host.tested),
    line("Next step", view.nextStep, view.nextStep === NOTHING_TO_DO)
  ];
}

// src/tui.tsx
var EVENTS = ["server.connected", "agent.updated", "integration.updated", "credential.updated", "credential.switched"];
var UNAVAILABLE = "STATUS_UNAVAILABLE: The Inference server part did not answer. Next step: Restart OpenCode.";
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
    const refresh = async () => {
      if (closed) return;
      const current = ++generation;
      controller?.abort();
      const request = controller = new AbortController();
      setState((previous) => ({
        ...previous,
        loading: true
      }));
      try {
        const view = await context.client.rpc(Inference).status({}, {
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
        var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$4 = _$createElement("text");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$4);
        _$setProp(_el$, "flexDirection", "column");
        _$setProp(_el$, "paddingLeft", 2);
        _$setProp(_el$, "paddingRight", 2);
        _$setProp(_el$, "paddingBottom", 1);
        _$setProp(_el$, "gap", 1);
        _$insert(_el$2, STATUS_TITLE, null);
        _$insert(_el$2, () => state().loading ? " \xB7 refreshing" : "", null);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return state().view;
          },
          get fallback() {
            return (() => {
              var _el$6 = _$createElement("text");
              _$insert(_el$6, (() => {
                var _c$ = _$memo(() => !!state().loading);
                return () => _c$() ? "Loading status\u2026" : `${state().error}`;
              })());
              _$effect((_$p) => _$setProp(_el$6, "fg", theme.text.muted, _$p));
              return _el$6;
            })();
          },
          children: (view) => (() => {
            var _el$7 = _$createElement("scrollbox"), _el$8 = _$createElement("box");
            _$insertNode(_el$7, _el$8);
            _$setProp(_el$7, "maxHeight", 28);
            _$setProp(_el$8, "flexDirection", "column");
            _$insert(_el$8, _$createComponent(For, {
              get each() {
                return statusLines(view(), {
                  paste: true
                });
              },
              children: (line2) => _$createComponent(For, {
                get each() {
                  return `${line2.label}: ${line2.text}`.split("\n");
                },
                children: (row) => (() => {
                  var _el$9 = _$createElement("text");
                  _$insert(_el$9, row);
                  _$effect((_$p) => _$setProp(_el$9, "fg", line2.ok ? theme.text.base : theme.text.feedback.warning.base, _$p));
                  return _el$9;
                })()
              })
            }));
            return _el$7;
          })()
        }), _el$4);
        _$insert(_el$, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!state().view)() && state().error;
          },
          get children() {
            var _el$3 = _$createElement("text");
            _$insert(_el$3, () => `Refresh failed: ${state().error}`);
            _$effect((_$p) => _$setProp(_el$3, "fg", theme.text.feedback.error.base, _$p));
            return _el$3;
          }
        }), _el$4);
        _$insertNode(_el$4, _$createTextNode(`r refresh \xB7 esc close`));
        _$setProp(_el$4, "onMouseUp", () => void refresh());
        _$effect((_p$) => {
          var _v$ = theme.text.base, _v$2 = theme.text.muted;
          _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
          _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
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
