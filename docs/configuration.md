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
| `questionSets` | `{}` |
| `acceptanceProfiles` | `{}` |

<!-- /generated:options -->

- `access`: `all`, `ask-changes` or `read-only`. Decides the default rules below.
- `modules`: switches for the operations. `extractions` turns `inference_extract` on or off (it is refused with
  `MODULE_DISABLED` at execution when off); `decisions` and `understanding` change only what capabilities and plan report
  and status's `state`, as their tools do not exist yet.
- `profiles`: named routes, `{ "<name>": { "model": "<provider>/<model>" } }`. Setting it replaces the three defaults.
  A profile names a model; it never overrides a permission.
- `routing.mode` is `explicit` and `routing.fallbacks` must be empty: automatic fallback stays off until evaluated.
- `limits`: `concurrency` (1-8), `maxFields` (1-64; the schema's hard limit is 64), `deadlineMs` (1000-600000). A tool
  input can lower them, never raise them.
- `limits.concurrency` caps requests in flight in one process; more wait their turn. `limits.deadlineMs` bounds the
  provider request.
- `spend`: exact decimal USD strings, never floats. `requirePricedRoute` makes a route with no known price ineligible;
  `requireUpperBound` requires a genuine ceiling. The three budgets are the handoff's proposed defaults, not measured
  prices, and are still under review. See [Spend](#spend). Only `inference_extract` can spend, and only on an enabled
  route; none is enabled in this version.
- `data.requireZdr`: `true` makes a route without documented zero data retention ineligible. `false` means you have not
  asked for that restriction; it does not claim a provider retains nothing.
- `cache.enabled` must be `false`: the result cache is not implemented.
- `allowUntestedHost`: run on an OpenCode outside `>=2.2.3 <2.3.0`, with a warning as the next step.

## Spend

`inference_extract` reserves before it sends (on an enabled route; none is enabled in this version):

- **Request.** The reservation is the route's upper bound when one is known. An estimate is not a cap, so with only an
  estimate, or with no price when `requirePricedRoute` is off, the call reserves the whole per-request budget
  (`spend.requestUsd`, or a lower `limits.maxEstimatedCostUsd` from the tool input). That budget is an admission limit,
  not a spend ceiling: OpenRouter does not enforce it.
- **Session and rolling 24 hours.** A call is admitted only if its reservation, plus everything already counted, fits
  `spend.sessionUsd` for its session and `spend.rolling24hUsd` for the last 24 hours. Counted are settled charges,
  reservations in flight, and reservations kept for calls whose cost is unknown.
- **Settlement.** Reported charges replace the reservation, platform and upstream charges kept separate. A call that
  failed after it may have been sent, timed out, was cancelled mid-request or got a malformed answer keeps its
  reservation: failure does not mean zero cost. Only a call that certainly never left releases it. Credits are never
  added to dollars.
- **Scope.** One journal per OpenRouter connection on this machine (`$XDG_STATE_HOME/opencode-inference`, or
  `~/.local/state/opencode-inference`), shared by every project and process here. It is not an account-wide limit
  across machines or other clients; OpenRouter's own key limits are the stronger, independent boundary.

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
| `inference_extract` | `*` | `allow` |
| `inference_decide` | `*` | `allow` |

<!-- /generated:rules-all -->

<!-- generated:rules-ask-changes -->

`access: "ask-changes"`

| Action | Resource | Effect |
| --- | --- | --- |
| `inference_*` | `*` | `ask` |
| `inference_status` | `*` | `allow` |
| `inference_capabilities` | `*` | `allow` |
| `inference_plan` | `*` | `allow` |
| `inference_extract` | `*` | `ask` |
| `inference_decide` | `*` | `ask` |

<!-- /generated:rules-ask-changes -->

<!-- generated:rules-read-only -->

`access: "read-only"`

| Action | Resource | Effect |
| --- | --- | --- |
| `inference_*` | `*` | `deny` |
| `inference_status` | `*` | `allow` |
| `inference_capabilities` | `*` | `allow` |
| `inference_plan` | `*` | `allow` |
| `inference_extract` | `*` | `deny` |
| `inference_decide` | `*` | `deny` |

<!-- /generated:rules-read-only -->

`inference_extract` gets the send effect of `access`; the namespace rule covers the send tools a later release adds; the
three local reads are always allowed. Reading a file for `inference_extract` also asks the host's own `read` (and
`external_directory` outside the project).

## Errors

Every failure is `CODE: what happened. Next step: …`, with one next step, and never contains a key, source text or a
field value. Host permission errors pass through unchanged. Operation failures name the operation id when its
reservation is kept, so it can be reconciled instead of resubmitted. `REVIEW_REQUIRED` is not a failure: it is
`review.required` on a successful result. `OUTPUT_EXPIRED`, `OUTPUT_UNAVAILABLE` and `CANCEL_UNSUPPORTED` arrive with
asynchronous operations.

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
| `CAPABILITY_UNSUPPORTED` | The selected route cannot serve this request. | Choose a supported field, modality or profile with inference_plan, or prepare the source explicitly. |
| `UNSAFE_PATH` | The source path is not a plain regular file this call may read. | Re-select the current regular file by a path without symbolic links or '..'. |
| `SOURCE_CHANGED` | The source changed between approval and reading, or no longer matches its declaration. | Re-select the current regular file and call the tool again. |
| `SOURCE_TYPE` | The source's bytes are not a type this call accepts, or do not match its declared type. | Select a file whose content matches its name, in a type the route accepts (see inference_capabilities). |
| `SOURCE_LIMIT` | The source is larger than the route accepts. | Select a smaller range or use an evaluated chunking strategy. |
| `CONTEXT_LIMIT` | The request is larger than the route accepts. | Select a smaller range or fewer fields, or use an evaluated chunking strategy. |
| `AUTH_REQUIRED` | No OpenRouter key is connected for Inference. | Run /connect and choose OpenRouter for Inference, then enter an OpenRouter API key. |
| `AUTH_REJECTED` | OpenRouter did not accept the connected key. | Run /connect and choose OpenRouter for Inference to replace the key. |
| `PRICE_UNKNOWN` | No price, or no upper bound, is known for this route, and the spend options require one. | Select a priced, affordable route, or change spend.requirePricedRoute or spend.requireUpperBound in the trusted options. |
| `BUDGET_EXCEEDED` | This call would exceed a spend budget. | Select a priced, affordable route, wait for the rolling window, or raise the limit in the trusted spend options. |
| `JOURNAL_LOCKED` | The operation journal is locked by another process and was not taken over. | Make sure no other OpenCode process is using Inference, then remove the lock file named above and retry. |
| `JOURNAL_UNREADABLE` | The operation journal could not be read or written. | Check the Inference state folder's permissions and free space; do not delete the journal while operations are unsettled. |
| `PROVIDER_ERROR` | OpenRouter answered with an error. | Retry later; a failed call may still have been charged, so check usage before retrying. |
| `PROVIDER_CONTRACT_CHANGED` | OpenRouter's response did not match the reviewed contract for this route. | Disable that adapter revision and update its fixtures and schema; do not retry the same call. |
| `SUBMISSION_UNKNOWN` | The request may have reached OpenRouter, but its outcome is unknown. | Reconcile the existing operation; do not resubmit. |
| `DEADLINE_EXCEEDED` | The call ran past its deadline. | Check whether OpenRouter received it before calling again; its reservation is kept. |
| `SESSION_UNKNOWN` | Refused by the tools RPC. | Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id. |
| `SESSION_AGENT_REQUIRED` | Refused by the tools RPC. | Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id. |
| `PERMISSION_DENIED` | Refused by the tools RPC. | Add an allow rule for the action to the session's agent or to the session, or use a session whose agent allows it. |

<!-- /generated:errors -->
