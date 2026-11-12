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
  money.ts                       exact decimal money (10^-12 units, never floats)
  json.ts                        a strict JSON reader that keeps provider numbers as written
src/providers/openrouter/
  capabilities.ts                the dated, documentation-derived capability fixture (data only)
  http.ts                        the transport boundary: the only fetch and the only key read
  extractions.ts                 the alpha Extractions adapter: wire request, constraints, strict answer, quote
  catalog.ts                     catalog drift, reported as a compatibility status
src/runtime/
  dispatch.ts                    the one dispatcher both host surfaces call
  handlers.ts                    status, capabilities and plan
  operation.ts                   the ordered operation pipeline and the provider adapter interface
  sources.ts                     source identification, permission requests, snapshots (policy; no fs)
  budget.ts                      reservations and admission at the request, session and 24-hour scopes
  journal.ts                     the operation journal: records, states, recovery, the process mutex
src/host/                        everything that touches the host
  plugin.ts                      setup, the cleanup stack, failure cleanup
  tools.ts                       the registry projected onto the model's tools
  scripting.ts                   the registry projected onto the tools RPC
  tools-rpc.ts                   the family's shared tools RPC (checked copy; plugin-specific block only)
  permissions.ts                 the default block, the exact-block matcher, the one-argument assert
  files.ts                       file metadata before approval, descriptor reads after it
  journal-store.ts               the journal's private files and the cross-process exclusive lock
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

Both host surfaces call `runTool` from `src/runtime/dispatch.ts`. It checks that the plugin is open and the tool and
its module are available at the moment of the call (the tools RPC's `available()` is for `describe` only), parses the
input strictly, fences cancellation, runs the handler (or, for a non-read tool, the operation pipeline below) and
validates the output against the tool's own schema. So a control added there holds for the model and for scripts alike.

<!-- generated:tools -->

| Tool | Host tool and permission | Code Mode | Tools RPC method | Jobs manifest | Class | Network | Uploads source | Billable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `inference.status` | `inference_status` | `tools.inference.status(input)` | `inference.core.tools/status` | `inference.core.status` | read | no | no | no |
| `inference.capabilities` | `inference_capabilities` | `tools.inference.capabilities(input)` | `inference.core.tools/capabilities` | `inference.core.capabilities` | read | no | no | no |
| `inference.plan` | `inference_plan` | `tools.inference.plan(input)` | `inference.core.tools/plan` | `inference.core.plan` | read | no | no | no |
| `inference.extract` | `inference_extract` | `tools.inference.extract(input)` | `inference.core.tools/extract` | `inference.core.extract` | send | yes | yes | yes |

<!-- /generated:tools -->

## Extraction

`src/providers/openrouter/extractions.ts` is the alpha Extractions adapter, with a documentation-derived and unverified
wire contract (`WIRE_REVISION`, part of every request fingerprint):

- **Request.** `model`, the text as `state` (or one image or PDF as an ordered `assets` entry, base64), `fields` in the
  provider's snake_case vocabulary (`null_threshold`, `decimals`, `integer`, `unit`, `items`, `max_items`) and
  `provider.allow_fallbacks: false`. Plugin-only options (`required`) are never sent. The route's constraints are
  refused locally with coded errors: a null threshold where the route or the field kind does not take it (Clairic lists,
  ScaleDown, unknown support), an image over Clairic's per-image or decoded-total limit or of a type it does not take,
  a PDF on a route without PDF input, a body over the route's request limit.
- **Answer.** Read with a strict JSON reader (`src/domain/json.ts`) that keeps each number's literal and refuses
  duplicate keys. `answers` must have exactly the requested keys; each value must have its field's JSON type;
  probabilities must lie in 0..1; spans must be code-point ranges of the exact text sent, or name asset 0 for the one
  asset sent; the model must be the requested one. Any of these failing is `PROVIDER_CONTRACT_CHANGED`. Unknown
  metadata is ignored, bounded and counted in coverage warnings.
- **Result.** Per field: the nullable value (a number also as `exact`, its literal), `derivation`, the reported
  confidence, null probability and spelling confidence when present (absent otherwise, never 0), the diagnostic guess
  apart from the value, evidence (`exact-text` spans with the span's own hash; `unavailable` for an image), list items
  with their own evidence (an item without a span keeps an empty list), and review reasons: `FIELD_ABSENT`,
  `REQUIRED_FIELD_ABSENT`, `CONFIDENCE_MISSING`, `EVIDENCE_UNAVAILABLE`, `EVIDENCE_MISMATCH`, `VALIDATION_FAILED`
  (integer, decimals, calendar dates and times, list size) and `PROVIDER_TRUNCATED`. Checks never repair a value.
  Coverage is complete for text unless the provider truncated, unknown for a file read natively. Every result is
  reviewed under the uncalibrated `review-first-v1`.
- **Money.** `usage.cost` is read from its literal and rounded UP to 12 places; its upstream breakdown is never added to
  it, and only under BYOK is a reported upstream amount a separate charge. A per-request price is an exact upper bound;
  a per-token input price is bounded by the body's UTF-8 bytes and rounded up; an output price or an image input makes
  the quote an estimate.
- **Routes.** Every route stays `enabled: false`; the fixture's schema refuses an enabled route without a passed
  canary. `catalog.ts` compares OpenRouter's catalog with the fixture and reports drift (new candidates, missing
  models) without enabling anything. `scripts/canary-extractions.ts` is the opt-in live check (see CONTRIBUTING.md).

## Reserved operations

Named for capabilities, plan and these docs; not tools, methods or permission rules in this version. Each is `send`:
cloud inference transmits supplied content and can spend, even when no business record changes.

<!-- generated:planned -->

| Operation | Reserved tool | Class | Module | Registered |
| --- | --- | --- | --- | --- |
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
- `ExtractData`
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

Fixture `openrouter-2026-11-11.2`, reviewed 2026-11-11, documentation-derived, verified: false.

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

## The operation pipeline

`runTool` runs a read-class tool's local handler. Every other tool is an operation and runs one ordered pipeline
(`src/runtime/operation.ts`, handoff §7), the same on the model path and the tools RPC. A non-read tool without a
provider adapter cannot run. `inference_extract` is the one such tool, with the Extractions adapter in `ADAPTERS`
(`src/host/plugin.ts`); the pipeline's own controls are also exercised by a test-only operation with a fake adapter and
a fake transport (`test/support/operation-kit.ts`).

1. The input is parsed strictly. The tool and its module are re-checked at the moment of the call.
2. The route comes from the trusted options and the reviewed fixture: the requested profile or model, eligible now
   (enabled, documented, module on, a type and field set it accepts, a price when `requirePricedRoute` is on). A key
   must be connected; only its presence is checked. Unsupported requests fail here, before any file is touched.
3. The source is identified from its descriptor and file metadata only (`lstat`, the parent's real path): no byte is
   read, nothing is sniffed or hashed. `..`, a final symbolic link, a symbolic link anywhere inside the project, a
   non-file, a foreign or expired artifact, and a bundle are refused here.
4. The host decides: `read` on the file (relative inside the project, absolute outside), after `external_directory`
   outside the project. Outside the project both name the file's real folder, never a linked one, and the file is read
   from there, in the host read tool's own actions, through the one-argument assert raced against
   cancellation and fenced after it settles. A denial propagates unchanged; a script's ask is refused by the tools RPC.
5. The approved file is opened through a descriptor without following a final symbolic link, and must be the same file
   that was approved (device, inode, size, change times) before and after the read; one byte past its size shows it
   grew. Its type comes from its bytes and must agree with its name or declaration; an artifact must match its declared
   size and hash. The bytes become an immutable private snapshot with their SHA-256.
6. Type and size are re-validated against the snapshot; the adapter builds the exact request, which must fit the route.
7. The reservation is admitted and persisted with a `planned` record in one locked step, then `dispatching` is
   persisted. Requests in flight in one process are capped by `limits.concurrency`.
8. The transport (`src/providers/openrouter/http.ts`) resolves the key, puts it in one header, and posts to the one
   trusted origin and a reviewed path, with no redirects, the deadline, a request cap, a streamed 4 MiB response cap
   and cancellation. Each failure says whether anything can have left.
9. The adapter validates the answer strictly; a 2xx is only transport success.
10. The journal settles: reported charges, or the reservation kept when the cost is unknown. The result carries the
    operation id, route, coverage, review, usage and trace, and the text names no source content.

### The journal and its lock

One private journal per OpenRouter connection on this machine: `journals/<label>/journal.json` (0600) in a 0700 folder
under `$XDG_STATE_HOME/opencode-inference` (or `~/.local/state/opencode-inference`). Each record follows the handoff's
`OperationRecord` for synchronous operations: project, account label, intent (the tool call), session and agent, route,
source hashes, constraint and request digests, state, owner, reservation, charges, cost status, an error code and the
submit attempt. It holds no key, source text, request or response body, or URL.

- States: `planned` → `dispatching` → `completed` | `failed` | `submission_unknown`; `planned` → `failed` when the
  call never left. A record is dispatched only by the process that planned it, under the lock.
- A process mutex serialises one process's transactions; an exclusive lock file (`O_CREAT|O_EXCL`, holding the
  owner's pid, a host hash and a token) serialises processes. It is held only for the read-modify-write, never across
  a network call, and the journal is replaced atomically (temporary file, flush, rename, folder flush).
- A lock still held after a bounded wait is never taken over on a timer, whatever its age: the call fails with
  `JOURNAL_LOCKED`, naming the lock file, its owner's pid and whether that process is running, and a person removes it.
- Recovery runs inside each transaction: another process's `planned` record whose owner is confirmed not running is
  released (it cannot have been sent), and its `dispatching` record becomes `submission_unknown` and keeps its
  reservation. An owner that may be alive, on another host or with an unclear answer, is left alone.
- A journal that does not parse, or belongs to another connection, is refused and left as it is, never reset.
- Terminal records leave after 30 days; held reservations and `submission_unknown` records stay.

Status still reports `tracking: "none"` for spend and operations: no registered tool writes the journal in this
version. Status totals arrive with the first billable tool.
