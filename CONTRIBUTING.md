# Contributing

This repository builds `@we-the-rebel-alliance/inference-plugin`, an OpenCode plugin on
[plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract) v0. Read
[the plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md) and
[the contract](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/contract.md) before changing
anything. The manifest in `package.json` is the source of truth; the plugin's code is written around it.

## Setup

You need Node.js 24 or later, npm, and [Bun](https://bun.sh) 1.4.4.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` is the whole gate. CI runs the same gate in one job named `ci`, on Ubuntu 24.04 with Node 24 and Bun 1.4.4.

1. `lint`: `biome check .` over the repository, with the formatter off and the recommended linter rules on.
2. `typecheck`: `tsc --noEmit` over `src`, `test` and the scripts.
3. `bundle`: esbuild writes exactly `dist/index.js` (server, with the plugin's own code, the contract modules it imports
   and zod bundled) and `dist/tui.js` (the TUI, no zod). `NOTICE` holds the licence of every package inlined; the build
   fails when it no longer matches, and `node scripts/build.mjs --notice` rewrites it.
4. `test`: the unit tests (`bun test test/unit`).
5. `test:conformance`: the recorded two-account behaviour and the recorded status and bus nudge
   (`bun test test/conformance`).
6. `test:host`: the built plugin in the real embedded OpenCode 2.4.1 host (`bun test test/host`).
7. `test:pack`: `npm pack`, an offline install, and the installed package in the real host (`bun test test/pack`).
8. `npx plugin-kit check`: T0 and T1 on the real 2.4.1 host, an unsupported host's refusal, the accounts, bus, status,
   the required doc files, the generated sections, the forbidden scan and the bundled-kit check.

`npx plugin-kit docs` regenerates the sections between `<!-- generated:… -->` markers from `package.json`; never edit a
generated section by hand. `npx plugin-kit record --account <alias>` records and redacts a conformance fixture from a
real account; the committed fixture is synthetic and both aliases are invented.

## Layout

- `src/index.ts` — the one `Plugin.define`, the host gate, and one `register` call.
- `src/handlers/` — one file per method. A handler returns its answer; the register checks it against the schema.
- `src/provider/` — the one origin, the API paths and the two wire adapters. This is the only place a URL is named.
- `src/runtime/` — the ordered operation pipeline, the budget, the journal, and source handling.
- `src/domain/` — the pure rules: options, contracts, planning, capabilities, acceptance, money and errors.
- `src/accounts.ts`, `src/authorize.ts` — the account wiring and the file-effect asserts.
- `fixtures/conformance.json` — what the plugin's own tests recorded, replayed by the kit.
- `skills/` — `inference` (always), and `inference-extract` and `inference-decide` while their module is on.

## Adding or changing a method

1. Declare it in `package.json` `capabilities.methods` with its class and `accounts`, and in `options` if it needs a
   new option.
2. Add its handler in `src/handlers/`, its provider call in `src/provider/`, and its input/output schemas from the zod
   contracts.
3. Add unit tests, then record the two-account behaviour with `npx plugin-kit record`.
4. Run `npx plugin-kit docs`, then `npx plugin-kit check` and `npm run check`.
5. Describe it in `docs/capabilities.md` and, if agents should use it, in the skill.

No method is pinned by default, no per-request hook is allowed, and no runtime dependency may be added. Do not edit
`dist/` by hand.

## The network and the canaries

No check calls OpenRouter or any other network service. The unit tests spy every fetch; the transport tests talk only to
loopback servers they start; the host tests run the embedded SDK offline. The opt-in canaries
(`npm run canary:extractions`, `npm run canary:decisions`) are the only code that spends money: they read a key only from
`OPENROUTER_CANARY_KEY`, refuse in CI and without a budget, a per-call worst case and `--yes-spend`, and a pass is
evidence for one adapter wire revision only.

## Releasing

The owner cuts a release with `npx plugin-kit release 0.0.0` from a clean `master` whose `ci` check passed, then pushes
the tag. The release workflow publishes exactly three files: the package tarball (`release/*.tgz`), `release/conformance.json`
and `release/SHA256SUMS` — never a bare `release/*` glob, since a directory there fails the upload. Agents never tag,
push a tag, or publish a release on their own.
