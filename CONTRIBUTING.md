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

## Commits

`npm run check` passes before every commit. Use `type(scope): summary`. Check `git config user.email` first; see
[AGENTS.md](AGENTS.md).

## Releasing

Not yet. The release kit scripts are here (`scripts/release-commit.mjs`, `release-pack.mjs`, `release-version.mjs`,
`changelog.mjs`, `check-release-shape.mjs`, `publish-release.mjs` and their test), but `release.yml` is not: the family's
CI-built release design is still in progress, and this plugin adds its workflow when it lands. Until then
`CHANGELOG.md` keeps its notes under `## [Unreleased]`.
