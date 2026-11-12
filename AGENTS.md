# Repository rules

This repository builds `@joe-broadhead/opencode-inference`, an unofficial OpenCode plugin for typed extraction and
bounded decisions with evidence, planned locally. The README is what users see. [docs/configuration.md](docs/configuration.md)
is the contract for options, permissions and errors. [docs/architecture.md](docs/architecture.md) is the design.
[CONTRIBUTING.md](CONTRIBUTING.md) covers setup and checks.

## Scope of this version

The shell, the registry, status and the local planner (handoff PR 1), plus the operation runtime (handoff PR 2):
sources and snapshots, the transport boundary, the operation journal, reservations and settlement, wired into the one
dispatcher. Registered tools: `status`, `capabilities`, `plan`, all class `read`, all strictly local. Do not register
`extract`, `decide` or `read` until they work: a reserved name lives in `PLANNED` (src/domain/registry.ts), never as a
callable stub, a method or a permission rule. The pipeline is tested with a test-only operation and a fake transport;
the first provider adapter goes into `ADAPTERS` (src/host/plugin.ts) with its registry entry.

## Design

- **Host.** Public `@opencode/plugin` APIs only. The host range is exactly `>=2.2.3 <2.3.0`, in `package.json`
  `opencode.host` and in the startup check; never `^2.2.3`.
- **Stable IDs.** Plugin `inference.core`, TUI `inference.core.tui`, namespace `inference`, status RPC `inference.core`,
  tools RPC `inference.core.tools`, permission prefix `inference_`, command `/inference-status`, key integration
  `inference-openrouter`.
- **One registry.** `src/domain/registry.ts` drives the model tools, the tools RPC methods and classes, the default
  permission block, the Jelly declaration in `package.json` and the generated docs tables. `test/unit/registry.test.ts`
  checks every projection; `UPDATE_GENERATED=1 bun test test/unit/registry.test.ts` rewrites the generated parts.
- **One dispatcher.** The model's tools and the tools RPC both call `runTool` (src/runtime/dispatch.ts). Every control
  goes there, so it holds on both paths. The tools RPC's `available()` is for describe only; the dispatcher re-checks
  availability on every call.
- **Layers.** `src/domain` is zod contracts and pure logic, with no host import. `src/runtime` runs tools.
  `src/host` touches the host. `src/providers/<provider>` holds provider data and, later, adapters.
- `src/host/tools-rpc.ts` is a copy of a module shared by several plugins: change only its block between the
  `PLUGIN-SPECIFIC` markers here, and the rest in the shared copy first. `scripts/check-copies.mjs` checks it.
- **Permissions.** The default block goes in through `ctx.agent.transform`, directly after each agent's base
  `* * allow`: the namespace rule `inference_*` (allow at `access: "all"`, ask at `ask-changes`, deny at `read-only`),
  then each registered tool by its class (reads always allow). Leave agents with no base allow alone, never change a
  deny, add no policy layer. An agent is guarded only when the whole block appears contiguously after its base allow
  (the exact-block matcher); a partial block is not installed. The transform skips an agent that already has the block.
- **Plain assert.** `ctx.permission.assert(input)` with one argument, raced locally against the signal and fenced after
  it settles (`createAuthorize`). Host permission errors propagate unchanged.
- **Cloud inference is `send`.** It transmits content and can spend. A model's answer never grants a permission.
- **The transport boundary.** `src/providers/openrouter/http.ts` is the only file that may reach the network or read
  the key. `npm run lint` checks the syntax tree (`scripts/check-network.mjs`, the TypeScript compiler API). Everywhere
  else in `src/`, modules are an ALLOW-LIST: a literal specifier naming a relative path, a listed builtin written with
  `node:` (`node:crypto`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:url`) or a listed package
  (`zod`, `@opencode/plugin` and its used subpaths, `solid-js`); anything else, `bun`, `node:vm` and non-literal
  specifiers included, is refused. Also refused: `eval`, `Function`, `.constructor` reads, `fetch`, `WebSocket`,
  `XMLHttpRequest`, `EventSource`, `Bun`, `Reflect`, `getBuiltinModule` and the loader escapes; `globalThis`, `window`,
  `self` and `global` other than a plain read of an allowed name; `process` other than `process.<name>`; `require`
  other than a literal call, and any `.require`; a computed key on anything that is, or aliases, the integration, a
  connection, `process`, a global or `Reflect`; the host connection API other than `….connection.<method>(…)` with a
  method that is not `resolve`. Known false positives (any `x.connection` kept as a value, the string `"resolve"`,
  `Reflect.*`, a variable named `self`): read members directly, rename, or use the plain operation; a new builtin or
  package is added to the allow-list in its own reviewed change. Trusted origin only, the key in one header, no
  redirects, deadline, byte caps, cancellation.
  Tests spy every network path (`test/support/network-spy.ts`) and assert zero calls from setup, status, capabilities,
  plan and every refused operation; transport tests use loopback servers only.
- **Operations.** A non-read tool runs the ordered pipeline in `src/runtime/operation.ts` (handoff §7): trusted route,
  metadata-only source identification, the host's file assertion, a descriptor read into an immutable snapshot,
  re-validation, a reservation persisted with the `planned` record, `dispatching` persisted, transport, strict
  validation, settlement. `src/domain` and `src/runtime` import no `fs`: file access is `src/host/files.ts` and
  `src/host/journal-store.ts` behind the runtime's `FileAccess` and `JournalStore` interfaces.
- **The journal.** Private, one per OpenRouter connection on this machine. A process mutex and an exclusive lock file;
  a held lock is never taken over on a timer. `submission_unknown` keeps its reservation and is never resubmitted.
  Money is exact decimal (src/domain/money.ts), never a float; credits are never added to dollars. The spend defaults
  are the handoff's proposals, not confirmed numbers.
- **The key.** The plugin owns the `inference-openrouter` key integration through `ctx.integration.transform`. Status
  reports only connected / not connected / needs sign-in / unknown, never the key. Keys are never options.
- **The fixture.** `src/providers/openrouter/capabilities.ts` is dated and documentation-derived. Every route stays
  `enabled: false` until its adapter and a compatibility canary exist. Never invent a price; bump `revision` on change.
- **One status model.** `/inference-status`, the status RPC, the TUI dialog and `inference_status` render one view.
  Its shared fields come first: `version`, `host` `{ version, range, tested }`, `state`, `unguardedAgents`, `nextStep`.
  Exactly one `Next step` line, `Nothing to do.` when nothing is needed. The TUI subscribes to events only while open.
- **Cleanup.** Every registration goes on the cleanup stack in `src/host/plugin.ts`, disposed in reverse on cleanup and
  on a failure part-way through setup.
- **Errors.** `CODE: what happened. Next step: …` with one next step. No error, log or status text contains a key,
  source text, a field value or a signed URL.

## Forbidden

`npm run lint` (scripts/check-forbidden.mjs) enforces, in `src/`, `test/`, `scripts/` and `dist/`: one-argument
`permission.assert`; no `ctx.experimental.artifact`; no `@opencode/ai`, `@opencode-ai/*` or host source imports; no
permission `evaluate` hook except the tools RPC's own, once; `import * as z from "zod"` only; no install or pack scripts
or peer/bundled dependencies; no absolute local paths; nothing bundled into `dist/` except zod; no network outside the
transport boundary.

## Package

- ESM. No `dependencies`, no `peerDependencies`, no lifecycle scripts, no `.d.ts`. `@opencode/plugin`, `@opencode/sdk`
  and `@opencode/client` are exact `2.2.3` devDependencies.
- `dist/` is exactly `index.js` (zod bundled) and `tui.js` (no zod; the build fails otherwise). Neither imports a
  relative path. `exports` is `.`, `./tui` and the three icons. `files` is a whitelist. `NOTICE` covers exactly the
  packages bundled into `dist/`; the build checks it.
- The icons follow the family icon contract: `scripts/check-icons.mjs` is the kit's file, verbatim. The package declares
  `opencode.vendor` OpenRouter because the kit requires a vendor for packages outside its own-products list.
- The release kit scripts come from the family kit; `release.yml` is not here yet.

## Checks

- `npm run check` is the one command, and it passes before every commit. npm installs and runs the scripts; Bun 1.4.4
  runs the tests.
- `TESTED_HOSTS` in `src/host/versions.ts` is the one list of tested releases. The host stage runs the suite on each
  release's `@opencode/sdk`; the pack stage loads each stock release. A release that does not run fails the run.
- Host and pack runs put HOME, XDG, `OPENCODE_TEST_HOME` and `TMPDIR` in a temp root under `/tmp`, never under the
  real home, and fail a host that tried to leave loopback.
- No test calls OpenRouter or any other network service. No live canaries.
- Do not skip, weaken or delete a test to get green.

## Writing

- Never commit keys, tokens, personal data, hostnames or absolute local paths.
- Commit messages use `type(scope): summary`.
- Every commit is authored and committed as `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`. Check
  `git config user.email` before committing.
- Keep the README, `docs/`, `SECURITY.md`, `CONTRIBUTING.md` and `CHANGELOG.md` in step with the code.
