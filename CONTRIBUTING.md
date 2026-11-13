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
check runs it. To run it, use a dedicated OpenRouter key with its own credit limit, read at a hidden prompt so it never
lands in your shell history:

```sh
read -rs OPENROUTER_CANARY_KEY && export OPENROUTER_CANARY_KEY
bun scripts/canary-extractions.ts --budget-usd 0.02 --per-call-usd 0.005 --yes-spend --only catalog,text --dry-run
bun scripts/canary-extractions.ts --budget-usd 0.02 --per-call-usd 0.005 --yes-spend --only catalog,text --shape
unset OPENROUTER_CANARY_KEY
```

It refuses in CI and without the key, a budget of at most 0.10, a per-call worst case and `--yes-spend`. Before each call
the spend so far plus that worst case must fit the budget; after it, the reported charge counts whatever the HTTP
status, or the worst case when none is reported. `--dry-run` prints what it would send and skip. `--shape` adds each
answer's structure (paths, types and lengths, never a value or the source text) and, when the adapter refuses an answer,
the exact refusal: the path, what the contract expects and the type found. It reads only answers already paid for.
It prints a report, naming the wire revision it checked and the commit it ran from, and never edits the fixture: record
a passed canary in `src/providers/openrouter/capabilities.ts` (the route's `canary` with its request and
malformed-request reports and `wireRevision`, and a new `revision`) in its own reviewed change before enabling a route.

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

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. Start the release with that commit's full sha:
   `gh workflow run release.yml --ref master -f sha=<full sha>`, or from Actions → release →
   Run workflow, on `master`.
4. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
5. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful `ci.yml`
  push run, a version that is not `x.y.z`, a CHANGELOG whose newest release is not this version, a release that does not
  move forward from the last published Release, a leftover `release/v<version>` branch, a native run that did not build
  this sha on `master`, by hand, with success, and a missing `native_run` (or one given to a plugin that is not native);
- **builds** `dist/` with `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release
  files: `dist/`, `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.2.3 to 2.2.6);
- **packs** the commit before installing anything and keeps that tarball, then runs the pack stage against a copy;
- **stages** the Release: verifies the attested native files, writes `SHA256SUMS` and the notes (the version's CHANGELOG
  section), and shows them all in the run summary with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, and every native file is the one the release commit's
`manifest/native.json` pins, size and sha256, with each gzip holding the pinned executable. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/joe-broadhead/opencode-inference/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
Jelly installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:joe-broadhead/opencode-inference#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/release-kit.test.mjs` and
`.github/workflows/release.yml`. Do not re-run the older `apply-release-kit.mjs`: it writes back the kit that could
release only `v0.0.0`.
