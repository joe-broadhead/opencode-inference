# Vendored family plugins (test fixtures)

The released Jobs and Utilities plugins, as test fixtures for `test/host/jobs.test.ts`, which runs the recipe in
docs/jobs.md through them on the embedded host. The test never touches the network or the user's home: it loads only
these files, after checking each one against its folder's `FILES.sha256` (the test refuses to run on any mismatch,
missing file or unlisted file).

Both are the owner's MIT-licensed family plugins; each folder keeps its own `LICENSE` and `NOTICE`. Only the files the
server plugin needs are kept, byte for byte as released: `package.json`, `LICENSE`, `NOTICE`, `dist/index.js`, Jobs'
`dist/quickjs.wasm`, the shipped `skills/` and Utilities' `manifest/`. The TUI bundle, icons, README and CHANGELOG are
left out.

## Provenance

Fetched once, on 2026-11-12, from each repository's published `v0.0.0` Release, and verified against that Release's
`SHA256SUMS` before extraction.

| Plugin | Release tarball | Tarball SHA-256 (as in the Release's SHA256SUMS) | SHA256SUMS file SHA-256 |
| --- | --- | --- | --- |
| `jobs@0.0.0` | https://github.com/joe-broadhead/opencode-jobs/releases/download/v0.0.0/joe-broadhead-opencode-jobs-0.0.0.tgz | `1a341a55bf190143c821c1b1f5520da02da601175cb8646852a95af3c1230cc7` | `2c4c5ca6c38f9e746ecd3877f3b58d005291bee1eb2e33596ac0c452a9833359` |
| `utilities@0.0.0` | https://github.com/joe-broadhead/opencode-utilities/releases/download/v0.0.0/joe-broadhead-opencode-utilities-0.0.0.tgz | `d49fd0e5832aafb1c98f21d755348537e9fc0fc660ee3ad74220654a2ed6c2d9` | `8e80113287979e56495789133abeea00f497517b9a3d9f1c21ffc0f706983769` |

The sums files: https://github.com/joe-broadhead/opencode-jobs/releases/download/v0.0.0/SHA256SUMS and
https://github.com/joe-broadhead/opencode-utilities/releases/download/v0.0.0/SHA256SUMS.

## Updating

Download the new Release's tarball and `SHA256SUMS`, verify the tarball (`sha256sum -c`), extract the files listed
above into a new `<name>@<version>/` folder, write its `FILES.sha256` (`sha256sum` of every file, sorted by path), update
this table and the version in `test/host/harness.ts`, and remove the old folder, all in one reviewed change.
