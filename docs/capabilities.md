# Capabilities

Every capability is declared in `package.json` `capabilities` and reached through the contract's one `register` call:
the agent tool, Code Mode and RPC are the same handler. The generated table below is the manifest's own.

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | — |
| `probe` | read | optional | — |
| `capabilities` | read | none | — |
| `plan` | read | none | — |
| `extract` | send | optional | `openrouter.extractions` |
| `decide` | send | optional | `openrouter.decisions` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|

### Actions

None.

### Bus events

`rpc.inference.account`
<!-- /generated:capabilities -->

## Methods

**Reads, which spend nothing and read no key**

- `status` — the OpenCode release and its range, every account alias with its state, the agents whose rules no longer
  hold, and one next step. It never reads a key and calls no provider. `accounts: none`.
- `probe` — one alias's sign-in: whether OpenCode holds a usable key, and the integration that holds it. It reads no
  content and never the key. `accounts: optional`. It emits `rpc.inference.account` with the alias's state.
- `capabilities` — the implemented operations and the reviewed fixture: each route's inputs, field and question kinds,
  limits, price when known, profiles that name it, and why it cannot run now. It is a dated, documentation-derived
  fixture; nothing is refreshed or called.
- `plan` — a local quote and review for an extract, decide or read call. It returns the route and its exclusions, the
  preparation execution would need, what would be sent and where, a quote, expected coverage, likely review and the
  unknowns. It never opens a file, uploads, calls a provider or spends. **A plan is not a permission** and it mints no
  plan id: `extract` and `decide` are plain sends that take their full input.

**Sends, which reach the provider and can be charged**

- `extract` — named typed fields from supplied text, a local file or an artifact, on an enabled Extractions route. Each
  result keeps the nullable value (a guess never fills it), evidence as Unicode code-point spans of the exact source,
  the number exactly as written, review reasons, coverage, usage and cost. `operations: openrouter.extractions`.
- `decide` — noul, choice and score answers with the probability or distribution exactly as reported (never
  renormalised), per-question refusal, and a deterministic acceptance under `review-first-v1` or an evaluated
  automatic profile. `operations: openrouter.decisions`.

A send asks the host before reading a file (`read`, and `external_directory` outside the project), reserves the budget
before sending, and settles the journal with the reported cost. A call whose outcome is unknown keeps its reservation:
`SUBMISSION_UNKNOWN`, `DEADLINE_EXCEEDED` or `CANCELLED` after sending means the provider may still have charged it.

The `read` operation is reserved: `capabilities` and `plan` describe it as not implemented, and it has no method, tool
or permission rule in this version.

## Spend classes

The contract's method table has no per-method spend class. `extract` and `decide` are class `send`, and each result
carries its own cost in `usage.charges` and `usage.costStatus`; `plan` quotes a route before a send. The `spend` options
are the caps (see [configuration](configuration.md)). `status` has no cost total: the contract's status shape has no
cost field.

## Sources and actions

None. Inference reads what a call supplies (text, a file or an artifact); it has no feed, no cursor, no scope and no
snapshot an app can bind to, so `sources` is empty. It writes nothing outside its own journal, so `actions` is empty.
A call's `source` is untrusted input, not a source capability.

## Bus events

`rpc.inference.account` carries `{ account, state }` when an account signed in, needs sign-in, or is in error. It is a
nudge: an app re-reads `status` or `probe` and gets the content there. There is no `changed` event, because there is no
source whose change the plugin could know about, and no `status` event: status is pulled, never pushed.

## The doors

Every method is one handler, reachable as:

1. the agent tool `inference_<method>`;
2. Code Mode and automations: `tools.inference.<method>(input)`;
3. RPC: `POST /api/rpc/inference/<method>` with `{ sessionID, input }`.

A non-read method over RPC runs only with an answered permission ask or a host-signed action grant; an allow rule is not
a confirmation. Nothing is RPC-only.
