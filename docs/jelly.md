# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this package's `package.json` as
JSON, without loading the plugin, when a person reviews the exact version, and uses it as follows.

Jelly names the plugin **Inference** (`jelly.title`), with the package name and version beneath, the one line in
`jelly.summary`, and the mark in `jelly.icon` (`assets/icon.svg`, shipped in the package), which Jelly keeps only if it
is a clean SVG of drawing elements.

## Tools and permissions

3 tools are declared (3 read-only): `inference.status`, `inference.capabilities` and `inference.plan`, the three local
tools of this version. None calls a network service. Jelly's agents have no base "allow everything" rule, so this
plugin's own default rules never reach them; every declared tool is `allow`, so a declared effect changes nothing in
Jelly.

- Ask: none.
- Off: none.

The declaration is generated from the registry (`src/domain/registry.ts`) and checked by `test/unit/registry.test.ts`.
The send tools a later release adds are not declared until they exist.

## Skills

None in this version.

## Views and scripts

None: `jelly.views` and `jelly.rpc` are empty.

## Signing in

Nothing is required. `jelly.signIns` declares one optional sign-in, `openrouter`: the plugin's own key integration
`inference-openrouter` (`required: false`), with a link to where OpenRouter keys are created. This version never reads
the key; status shows only whether it is connected.

## Versions

Jelly's curated catalogue pins an exact version. Each release is published under a new version, so a review in Jelly can
tell the two apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`. `scripts/check-copies.mjs` holds the kit, and the
shared part of the tools RPC (`src/host/tools-rpc.ts`), equal to the copy every plugin carries.
