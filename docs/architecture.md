# Architecture

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

This is the design of the shell that later releases build on. The tables marked generated are written from the source
(`test/support/generated.ts`); `test/unit/registry.test.ts` fails while they differ.

## Identities

| Surface | Value |
| --- | --- |
| npm package | `@joe-broadhead/opencode-inference` |
| Plugin | `inference.core` |
| TUI | `inference.core.tui`, palette "Inference: Status", slash `/inference` |
| Namespace | `inference` (Code Mode `tools.inference.<name>`) |
| Status RPC | `inference.core`, method `status` |
| Tools RPC | `inference.core.tools`, `describe` plus one method per tool |
| Permission prefix | `inference_` |
| Status command | `/inference-status` |
| Key integration | `inference-openrouter` ("OpenRouter for Inference" in `/connect`) |

## Layers

```text
src/index.ts                     Plugin.define entry
src/domain/                      zod contracts and pure logic, no host
  ids.ts                         identities and the status view types (zod-free; the TUI imports it)
  contracts.ts                   the public plugin-domain schemas, exported as JSON Schema
  config.ts                      strict trusted options
  registry.ts                    the single tool registry, and the reserved operations
  routing.ts                     deterministic eligibility and the local plan
  capabilities.ts                the capabilities answer
  status-schema.ts               the status view's zod schema (server only)
  errors.ts                      CODE: what happened. Next step: …
src/providers/openrouter/
  capabilities.ts                the dated, documentation-derived capability fixture (data only)
src/runtime/
  dispatch.ts                    the one dispatcher both host surfaces call
  handlers.ts                    status, capabilities and plan
src/host/                        everything that touches the host
  plugin.ts                      setup, the cleanup stack, failure cleanup
  tools.ts                       the registry projected onto the model's tools
  scripting.ts                   the registry projected onto the tools RPC
  tools-rpc.ts                   the family's shared tools RPC (checked copy; plugin-specific block only)
  permissions.ts                 the default block, the exact-block matcher, the one-argument assert
  integration.ts                 the plugin-owned OpenRouter key entry and its connected/not-connected state
  status.ts, commands.ts         the status view and /inference-status
  versions.ts, compat.ts         the host range and the tested releases
src/rpc.ts                       the status RPC contract (plain JSON Schema) and every status row
src/tui.tsx                      the status dialog
```

`dist/` is exactly `index.js` (server, with zod bundled) and `tui.js` (no zod: the TUI imports only `src/domain/ids.ts`,
`src/rpc.ts` and `src/host/versions.ts`). The build fails if the TUI bundle inlines zod.

## One registry, one dispatcher

`src/domain/registry.ts` defines each tool's name, class, effects, description and input and output schemas. From it:

- the model tools (`src/host/tools.ts`): host tool `inference_<name>`, permission `inference_<name>`, namespace `inference`;
- the tools RPC methods (`src/host/scripting.ts`): method `<name>`, the same class and action, JSON Schema from the same zod;
- the default permission block (`src/host/permissions.ts`): the namespace rule, then each tool by its class;
- the Jelly declaration in `package.json` and the tables in these docs, checked by `test/unit/registry.test.ts`.

Both host surfaces call `runTool` from `src/runtime/dispatch.ts`. It checks that the plugin is open and the tool is
available at the moment of the call (the tools RPC's `available()` is for `describe` only), parses the input strictly,
fences cancellation, runs the handler and validates the output against the tool's own schema. So a control added there
holds for the model and for scripts alike.

<!-- generated:tools -->

| Tool | Host tool and permission | Code Mode | Tools RPC method | Jobs manifest | Class | Network | Uploads source | Billable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `inference.status` | `inference_status` | `tools.inference.status(input)` | `inference.core.tools/status` | `inference.core.status` | read | no | no | no |
| `inference.capabilities` | `inference_capabilities` | `tools.inference.capabilities(input)` | `inference.core.tools/capabilities` | `inference.core.capabilities` | read | no | no | no |
| `inference.plan` | `inference_plan` | `tools.inference.plan(input)` | `inference.core.tools/plan` | `inference.core.plan` | read | no | no | no |

<!-- /generated:tools -->

## Reserved operations

Named for capabilities, plan and these docs; not tools, methods or permission rules in this version. Each is `send`:
cloud inference transmits supplied content and can spend, even when no business record changes.

<!-- generated:planned -->

| Operation | Reserved tool | Class | Module | Registered |
| --- | --- | --- | --- | --- |
| `inference.extract` | `inference_extract` | send | `extractions` | no |
| `inference.decide` | `inference_decide` | send | `decisions` | no |
| `inference.read` | `inference_read` | send | `understanding` | no |

<!-- /generated:planned -->

## Contracts

`src/domain/contracts.ts` holds the plugin-domain schemas of handoff §5 and §15, version 1, strict and bounded. They are
not provider wire schemas: an adapter maps them inside the adapter. Exported as JSON Schema (`CONTRACT_JSON_SCHEMAS`):

<!-- generated:contracts -->

- `ArtifactRef`
- `SourceInput`
- `EvidenceRef`
- `Coverage`
- `Usage`
- `InferenceResult`
- `ExtractField`
- `QuestionInput`
- `ExtractInput`
- `DecideInput`
- `ReadInput`
- `PlanInput`
- `PlanResult`

<!-- /generated:contracts -->

## The capability fixture

`src/providers/openrouter/capabilities.ts` is data only. Every value was transcribed from OpenRouter's public
documentation, as summarised in the design handoff, on the date below. None was observed from the live API, no price
was stated, and every route is disabled until its adapter exists and a compatibility canary passes. A newer catalog
entry never enables a route by itself.

<!-- generated:routes -->

Fixture `openrouter-2026-11-11.1`, reviewed 2026-11-11, documentation-derived, verified: false.

| Model | Operation | Route | Status | Enabled | Text | Images | PDF | Field or question types | Price |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cloudflare/clairic` | extract | `POST /api/alpha/extractions` | documented | no | yes | 4 (image/png, image/jpeg, image/webp) | no | text, number, date, time, datetime, duration, list, estimate, forecast | unknown |
| `scaledown/extract` | extract | `POST /api/alpha/extractions` | documented | no | yes | 1 (image/png, image/jpeg) | 1 file | text, list | unknown |
| `inception/mercury-decide` | extract | `POST /api/alpha/extractions` | documented | no | yes | no | no | text, list | unknown |
| `levanto/sage-2` | extract | `POST /api/alpha/extractions` | unconfirmed | no | unknown | no | no | unknown | unknown |
| `typesafe/jev-1.14` | decide | `POST /api/alpha/decisions` | documented | no | yes | no | no | noul, choice, score, box | unknown |

<!-- /generated:routes -->

## Planning stays local

`inference_plan` uses only the options, the fixture, the clock and what the caller supplied. For supplied text it
counts bytes and Unicode code points and hashes the text. For a path it reads nothing: size, hash and type stay unknown,
and preparation names the authorized snapshot execution would take. For an artifact it reports the declared size and
hash as declared. It never refreshes a catalog, validates a key, asks a provider for an estimate or uploads.

Routing is explicit: the requested profile or model is the only candidate. Other reviewed routes for the task are
listed as alternatives with their own exclusion codes and are never chosen. A quote is `unavailable` when no price is
known, `estimate` for a price that is not a ceiling, and `upper_bound` only for a fixed ceiling; money is an exact
decimal string, computed with integer micro-dollars.

## Status

One view, built in `src/host/status.ts` and derived in `src/rpc.ts`, serves `/inference-status`, the status RPC, the
TUI dialog and `inference_status` (with the unguarded agents as a count). The family's shared fields come first:
`version`, `host { version, range, tested }`, `state`, `unguardedAgents`, `nextStep`. Then the connection (connected,
not connected, needs sign-in or unknown, never the key), access, modules, tools, the fixture's age, the spend limits,
operations and the permission block. In this version `state` is `local_only` (or `disabled` with every module off),
spend and operations report `tracking: "none"`, and the key does not drive the next step because no route uses it.

## Setup and cleanup

Setup validates the options and the host version before registering anything. Every registration (the `/connect`
entry, the agent rules, the tools, the status RPC, the tools RPC and its hook, the command) goes on one cleanup stack,
disposed in reverse on cleanup and on a failure part-way through setup. The tools RPC's own registrations are tracked
as they are made, so a failure inside the shared module leaves nothing behind. The agent transform skips agents that
already carry the exact block, so a replayed or reloaded transform never doubles it. The server holds no timers or
subscriptions; the TUI dialog subscribes to events only while open.

## What a later release adds

The handoff's PR 2 inserts, in `runTool`, between the input parse and the handler: source authorization and snapshots
(`src/runtime/sources.ts`), route revalidation, the one-argument assert (`createAuthorize`, already in
`src/host/permissions.ts`), operation-keyed reservations and the dispatch journal (`src/runtime/budget.ts`,
`src/runtime/journal.ts`), the credential boundary (`src/providers/openrouter/http.ts`, the only file `npm run lint`
lets fetch or resolve the key) and settlement. Status then reports committed, reserved and unknown spend.
