# Configuration

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

This page is the contract for the plugin's options, its default permission rules and its errors. The tables marked
generated are written from the source; `test/unit/registry.test.ts` fails while they differ.

## Options

Every option is optional. Unknown keys fail setup with each one named. A key-like option (any name containing `apiKey`,
`token`, `secret`, `password`, `credential`, `authorization` or `bearer`) fails setup too, named by its path and never
by value: the OpenRouter key goes in `/connect`.

<!-- generated:options -->

| Option | Default |
| --- | --- |
| `access` | `"all"` |
| `modules.extractions` | `true` |
| `modules.decisions` | `true` |
| `modules.understanding` | `false` |
| `profiles` | `{"extract-typed":{"model":"cloudflare/clairic"},"extract-pdf":{"model":"scaledown/extract"},"decide-text":{"model":"typesafe/jev-1.14"}}` |
| `routing.mode` | `"explicit"` |
| `routing.fallbacks` | `[]` |
| `limits.concurrency` | `2` |
| `limits.maxFields` | `32` |
| `limits.deadlineMs` | `60000` |
| `spend.requestUsd` | `"0.05"` |
| `spend.sessionUsd` | `"1.00"` |
| `spend.rolling24hUsd` | `"5.00"` |
| `spend.requirePricedRoute` | `true` |
| `spend.requireUpperBound` | `false` |
| `data.requireZdr` | `false` |
| `cache.enabled` | `false` |
| `allowUntestedHost` | `false` |

<!-- /generated:options -->

- `access`: `all`, `ask-changes` or `read-only`. Decides the default rules below.
- `modules`: switches for the reserved operations. In this version they change what capabilities and plan report
  (`MODULE_DISABLED`) and status's `state`; no module has a tool yet.
- `profiles`: named routes, `{ "<name>": { "model": "<provider>/<model>" } }`. Setting it replaces the three defaults.
  A profile names a model; it never overrides a permission.
- `routing.mode` is `explicit` and `routing.fallbacks` must be empty: automatic fallback stays off until evaluated.
- `limits`: `concurrency` (1-8), `maxFields` (1-64; the schema's hard limit is 64), `deadlineMs` (1000-600000). A tool
  input can lower them, never raise them.
- `spend`: exact decimal USD strings. `requirePricedRoute` makes a route with no known price ineligible;
  `requireUpperBound` requires a genuine ceiling. Admission budgets apply once a later release sends anything.
- `data.requireZdr`: `true` makes a route without documented zero data retention ineligible. `false` means you have not
  asked for that restriction; it does not claim a provider retains nothing.
- `cache.enabled` must be `false`: the result cache is not implemented.
- `allowUntestedHost`: run on an OpenCode outside `>=2.2.3 <2.3.0`, with a warning as the next step.

## Default permission rules

The plugin inserts one block directly after each agent's base `* * allow`, so the agent's own later rules, your rules
and saved approvals still win. Agents without a base allow are left alone. An agent counts as guarded only when the
whole block appears contiguously after its base allow; a partial block does not count. Status names an agent without
the block only when its own rules would run a send without asking, with the fix: put the block first in that agent's
own `permissions`, followed by your top-level `inference_*` rules.

<!-- generated:rules-all -->

`access: "all"`

| Action | Resource | Effect |
| --- | --- | --- |
| `inference_*` | `*` | `allow` |
| `inference_status` | `*` | `allow` |
| `inference_capabilities` | `*` | `allow` |
| `inference_plan` | `*` | `allow` |

<!-- /generated:rules-all -->

<!-- generated:rules-ask-changes -->

`access: "ask-changes"`

| Action | Resource | Effect |
| --- | --- | --- |
| `inference_*` | `*` | `ask` |
| `inference_status` | `*` | `allow` |
| `inference_capabilities` | `*` | `allow` |
| `inference_plan` | `*` | `allow` |

<!-- /generated:rules-ask-changes -->

<!-- generated:rules-read-only -->

`access: "read-only"`

| Action | Resource | Effect |
| --- | --- | --- |
| `inference_*` | `*` | `deny` |
| `inference_status` | `*` | `allow` |
| `inference_capabilities` | `*` | `allow` |
| `inference_plan` | `*` | `allow` |

<!-- /generated:rules-read-only -->

The namespace rule covers the send tools a later release adds; the three local reads are always allowed.

## Errors

Every failure is `CODE: what happened. Next step: …`, with one next step, and never contains a key, source text or a
field value. Host permission errors pass through unchanged.

<!-- generated:errors -->

| Code | What happened | Next step |
| --- | --- | --- |
| `INPUT_INVALID` | The tool input is invalid. | Correct the named fields against the tool's schema and call it again. |
| `OPTIONS_INVALID` | The plugin options are invalid. | Fix the named option in the Inference plugin options in opencode.json, then restart OpenCode. |
| `HOST_UNTESTED` | This OpenCode version is outside the range Inference supports. | Use a tested OpenCode release, or set the plugin option allowUntestedHost: true to run anyway. |
| `MODULE_DISABLED` | The module behind this tool is turned off in the plugin options. | Set modules.<name> to true in the Inference plugin options, then restart OpenCode. |
| `TOOL_UNAVAILABLE` | This tool is not available in this location right now. | Call inference_status to see what is available, then retry. |
| `CLOSED` | The Inference plugin is shutting down. | Retry after OpenCode has reloaded the plugin. |
| `CANCELLED` | The call was cancelled. | Call the tool again if you still need the result. |
| `STATUS_UNAVAILABLE` | Inference status could not be read. | Run /inference-status in a session to see the error, or check the OpenCode server log. |
| `OUTPUT_INVALID` | The tool produced a result that does not match its own schema. | Report it with the inference_status output; this is a bug in the plugin. |
| `RULES_NOT_ADDED` | The default permission rules could not be added. | Restart OpenCode. |
| `INTEGRATION_NOT_REGISTERED` | The OpenRouter key entry could not be added to /connect. | Restart OpenCode. |
| `SESSION_UNKNOWN` | Refused by the tools RPC. | Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id. |
| `SESSION_AGENT_REQUIRED` | Refused by the tools RPC. | Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id. |
| `PERMISSION_DENIED` | Refused by the tools RPC. | Add an allow rule for the action to the session's agent or to the session, or use a session whose agent allows it. |

<!-- /generated:errors -->
