# Architecture

Inference is a plugin on `plugin-contract` v0. The contract owns the doors, the manifest, accounts, access, the bus,
status, the error table and the plan/commit rules. This repository owns what only this provider knows: the routes, the
wire adapters, the source handling, the budget and the journal. No module of the contract is re-implemented here.

## Layers

```
package.json            the capabilities manifest, version, exports and devDependencies
src/
  index.ts              Plugin.define: assertHost, accounts, one register call, skills and the /inference command
  accounts.ts           one integration per alias, its key auth method, connection state and the probe owner
  authorize.ts          the file-effect asserts (read, external_directory) and their contract refusal
  commands.ts           /inference: the status answer as text
  files.ts              metadata before approval, a descriptor read after it
  journal-store.ts      the private 0700/0600 journal and its cross-process lock
  skills.ts             the two shipped skills, registered while their module is on
  status-text.ts        the status answer as people read it (TUI and command; no zod)
  tui.tsx               the /inference status dialog, reading the status RPC under an open session
  domain/               pure rules: options, contracts, planning, capabilities, acceptance, money, errors
  handlers/             one file per method: status, probe, capabilities, plan, extract, decide
  provider/             the provider client: the one origin, the API paths, the wire adapters, the fixture
  runtime/              the operation pipeline, the budget, the journal and source handling
```

`src/index.ts` reads `package.json` from the package root at load time (one level above `src/` or `dist/`), so the
manifest the kit reads from disk is the manifest the handlers answer with. It calls `assertHost(ctx, manifest)` first, so
an OpenCode outside `>=2.4.1 <2.5.0` leaves no half-wired plugin.

## One register call

`register(ctx, manifest, handlers)` validates the handler table against the manifest, resolves the accounts, generates
the access rules into every agent, registers one tool per method in the `inference` namespace, registers one RPC id
`inference` with the declared `account` event, and returns the registration. It also gives every handler call
`call.account`, `call.bus` and `call.unguardedAgents()`, so no handler keeps state between setup and a call. Each file in
`src/handlers/` exports one method handler: its description, its input and output JSON Schemas, and its `run`.

## The provider client

`src/provider/http.ts` is the only module that resolves a key or calls `fetch`. It names the one trusted origin once
(`https://openrouter.ai`; a loopback origin is accepted for tests) and the reviewed API paths exactly. The key is
resolved for the account's own integration (`inference` or `inference-<alias>`) at dispatch, put into one
`Authorization` header and nowhere else. Redirects are never followed, so the key cannot reach another origin; a
deadline, a request-byte cap, a response-byte cap and the call's cancellation all apply. Every failure says whether the
request can have been sent, which is what the journal records.

`src/provider/capabilities.ts` is the reviewed fixture: each route's inputs, field and question kinds, limits, price and
canary. A route runs only when it is enabled and its canary's wire revision is the adapter's own, so a changed adapter
cannot keep a route enabled without a new canary. `catalog.ts` compares the fixture with OpenRouter's public catalog;
`extractions.ts` and `decisions.ts` are the two wire adapters: a quote, the exact request, and a strict parse that never
repairs a malformed answer into success.

## The operation pipeline

`runtime/operation.ts` runs one send in a fixed order:

1. resolve the requested profile or model and the route, from trusted options and the fixture only;
2. resolve the account's key presence (not the key);
3. identify the source from its descriptor and file metadata, reading no bytes;
4. assert the file effects (`read`, and `external_directory` outside the project) on the real folder, raced against
   cancellation;
5. read the approved bytes through a descriptor, verify they are still the approved file, sniff the type and freeze a
   private snapshot with its SHA-256;
6. re-validate the route against the snapshot and build the exact request;
7. reserve the budget and persist the `planned` and `dispatching` records;
8. send through the one transport;
9. parse the answer strictly and settle the journal with the reported charges, or keep the reservation when the cost is
   unknown.

A file replaced, grown or touched between approval and reading is refused; so is a symbolic link, a `..` segment, a
foreign artifact and a file over the route's byte limit. The method's own action was already asserted by the contract's
register on `<alias>:<operation>` before the handler ran, so the pipeline adds only the file effects.

## Budget and journal

`runtime/budget.ts` is opt-in and operation-keyed: a call reserves before it sends, and a cap is checked against
committed, reserved and unknown spend at the request, session and rolling 24-hour scopes. `runtime/journal.ts` persists
hashes, ids, the route, timing, amounts and error codes; `src/journal-store.ts` keeps the journal private (0700 folder,
0600 file) and replaces it atomically under an exclusive lock. The journal never holds a key, source text, a request or
response body, a URL or a query string. An account's journal folder is keyed on a hash of its connection, so two aliases
never share a reservation ledger.

## Accounts and access

`src/accounts.ts` uses the contract's `accounts` module: `accountsOf` reads `options.accounts`, `registerAccounts`
registers one integration per alias with a `key` auth method, and `accountStatuses`/`statusAnswer` build the status
answer. The plugin never resolves a key to make status; it reads the connection's presence and status only.

The access rules are the contract's `access` module's: reads always run, sends follow `access`. The plugin names no rule
and patches no agent. `status` reports an agent whose later rules no longer give every generated rule its effect, and
never fixes it behind the person's back.

## Status, probe and the bus

`status` passes the manifest, the installed and host versions, every alias's state, the setup problems and
`await call.unguardedAgents()` to `statusAnswer`; it keeps no state of its own. An unreadable agent list is unknown, never
zero, so it becomes a problem and the state says `error`. `probe` reads the alias's connection and answers the
contract's probe shape; it emits `account` when the alias is ready or needs a sign-in. `rpc.inference.account` is the one
declared event: a nudge with no content. There is no `changed` event, because there is no source.

## The TUI and the command

`src/tui.tsx` registers `/inference` in the palette and the slash commands. It calls the status RPC under the active
session's rules and renders the answer; it changes nothing and polls nothing. `src/commands.ts` posts the same answer
into a session for people who work in the terminal.

## What is not here

- **No source, cursor or scope.** The plugin reads what a call supplies. There is no feed to page through and no cursor
  to bind, so no source is declared.
- **No result cache.** A repeated call is a repeated send and a repeated charge; the journal is for reconciliation, not
  for reuse.
- **No per-request hook.** The fixed context is the manifest's summary and the two skills; cost is in each result.
- **No compatibility path.** The contract v0 shape is the only shape; the old repository's tools RPC, app keys and
  hand-written build scripts are gone.

## OpenCode APIs used

Public `@opencode/plugin` 2.4.1 only: `ctx.app.version` for the host gate, `ctx.tool`, `ctx.rpc`, `ctx.session`,
`ctx.agent`, `ctx.permission`, `ctx.integration`, `ctx.skill`, `ctx.command` and `ctx.location`. The contract's
`register` narrows those types structurally, so the plugin's published declarations name no host type. No internal
OpenCode module is imported.
