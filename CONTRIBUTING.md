# Contributing

## Setup

You need Node.js 24 or later, npm, and [Bun](https://bun.sh) 1.4.4 (the Bun inside stock OpenCode 2.2.3 to 2.2.6).

```sh
npm ci --ignore-scripts
npm run check
```

`npm run build` writes exactly two self-contained files with esbuild: `dist/index.js` (server, with zod bundled) and
`dist/tui.js` (TUI, compiled from Solid JSX first, with no zod). The root `NOTICE` holds the licence of every package
bundled into `dist/`; the build fails when it no longer matches, and `node scripts/build.mjs --notice` rewrites it.

To try a checkout in OpenCode, build it and point a `plugins` entry at the repository directory.

## Checks

`npm run check` runs, in order:

1. `typecheck`: `tsc` over `src` and `test`.
2. `test`: the unit tests (`bun test test/unit`): contracts, options, planning and capabilities, permissions and the
   access matrix, the dispatcher, the operation pipeline on both host surfaces with a test-only operation (permission
   races, source integrity, budgets, ambiguous dispatch, secrets), the transport against loopback servers, the journal
   and its lock across real child processes, status, setup and failure cleanup, reload, the zero-network gate, the lint
   rules, and registry parity with the generated Jelly declaration and docs.
3. `test:kit`: the release kit's own tests (`node --test scripts/release-kit.test.mjs`).
4. `build`.
5. `test:tui`: the built `dist/tui.js` with OpenTUI's test renderer.
6. `test:host`: the host suite on the embedded `@opencode/sdk` of each tested release (`scripts/host-tests.mjs`; set
   `HOST_SDK_DIR` to run one).
7. `lint`: `scripts/check-forbidden.mjs`, `scripts/check-copies.mjs` and `scripts/check-icons.mjs`.
8. `test:pack`: packs the plugin, installs the tarball offline into an empty project, and loads it in each tested stock
   OpenCode release. Set `OPENCODE_BIN_2_2_3` and so on to stock binaries to skip installing them.

The tested releases are one list, `TESTED_HOSTS` in `src/host/versions.ts`. No check calls OpenRouter or any other
network service; the host harness fails a host that tried to leave loopback, the unit tests spy every network path, and
the transport tests talk only to loopback servers they start.
The host and pack stages download the SDK and stock OpenCode releases from npm.

The generated parts of `package.json` (`jelly`) and of the docs come from the registry. After changing a tool, an
option default, a failure code or the fixture, run:

```sh
UPDATE_GENERATED=1 bun test test/unit/registry.test.ts
```

## The Jobs recipe test

`test/host/jobs.test.ts` runs the recipe in [docs/jobs.md](docs/jobs.md) through the released Jobs and Utilities
plugins on the embedded host. They are vendored in `test/fixtures/family/<name>@<version>/`, byte for byte from their
verified `v0.0.0` Release tarballs, and every file is checked against the folder's committed `FILES.sha256` before it is
loaded; [the folder's README](test/fixtures/family/README.md) records the source URLs and digests and how to update
them. The test never touches the network or your home folder. The extraction reaches a loopback fake; nothing is paid
for.

## The compatibility canary

`scripts/canary-extractions.ts` checks the reviewed Extractions contract against the live API. It spends money, so no
check runs it. To run it, use a dedicated OpenRouter key with its own credit limit:

```sh
OPENROUTER_CANARY_KEY=<key> bun scripts/canary-extractions.ts --budget-usd 0.02 --per-call-usd 0.005 --yes-spend --only catalog,text
```

It refuses in CI and without the key, a budget of at most 0.10, a per-call worst case and `--yes-spend`. Before each call
the spend so far plus that worst case must fit the budget; after it, the reported charge counts whatever the HTTP
status, or the worst case when none is reported. `--dry-run` prints what it would send and skip.
It prints a report and never edits the fixture: record a passed canary in `src/providers/openrouter/capabilities.ts`
(the route's `canary`, a new `revision`) in its own reviewed change before enabling a route.

The Decisions canary works the same way: `bun scripts/canary-decisions.ts --budget-usd 0.02 --per-call-usd 0.005
--yes-spend --only catalog,text`.

## Evaluating an acceptance profile

An automatic acceptance profile loads only with a held-out report. Record answers for a labelled dataset (a key and
spend are needed for that), then, offline:

```sh
bun scripts/evaluate-decisions.ts --options options.json --profile <name> --dataset dataset.json --answers answers.json
```

Choose thresholds on the tuning split; the report measures them on the held-out split, split by document. Put the
report in the profile (`mode: "automatic"`, `model`, `maxFalseAcceptRate`) in its own reviewed change.

## Commits

`npm run check` passes before every commit. Use `type(scope): summary`. Check `git config user.email` first; see
[AGENTS.md](AGENTS.md).

## Releasing

Not yet. The release kit scripts are here (`scripts/release-commit.mjs`, `release-pack.mjs`, `release-version.mjs`,
`changelog.mjs`, `check-release-shape.mjs`, `publish-release.mjs` and their test), but `release.yml` is not: the family's
CI-built release design is still in progress, and this plugin adds its workflow when it lands. Until then
`CHANGELOG.md` keeps its notes under `## [Unreleased]`.
