# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this package's `package.json` as
JSON, without loading the plugin, when a person reviews the exact version, and uses it as follows.

Jelly names the plugin **Inference** (`jelly.title`), with the package name and version beneath, the one line in
`jelly.summary` ("Typed extraction and bounded decisions. The text, files and artifacts you give it go to OpenRouter."),
and the mark in `jelly.icon` (`assets/icon.svg`, shipped in the package), which Jelly keeps only if it
is a clean SVG of drawing elements.

`jelly.cost` is the line Jelly shows on the plugin's review before it installs, in the plugin's own words, saying what
it costs with OpenRouter: "Extract and decide calls are charged by OpenRouter to the key you add, per input token
(output is free on both enabled routes), and each result reports its cost. No spend cap is set unless you set one." It
changes nothing Jelly allows.

## Tools and permissions

5 tools are declared (3 read-only): `inference.status`, `inference.capabilities` and `inference.plan`, which are local,
and `inference.extract` and `inference.decide`, which send the text, files and artifacts you give them to OpenRouter and can be charged (class `send`;
they run only on a verified, enabled route). Jelly's agents have no base "allow everything" rule,
so this plugin's own default rules never reach them; every declared tool's effect is the one the default rules give at
`access: "all"`.

- Ask: none.
- Off: none.

No spend cap is set by default either: `inference.extract` and `inference.decide` run at whatever a call costs, and each
result reports that cost. The `spend` options set opt-in caps.

The declaration is generated from the registry (`src/domain/registry.ts`) and checked by `test/unit/registry.test.ts`.
`inference.read` is not declared until it exists. Every tool is the plugin's own, so there is no provider tool list to
capture: the registry is the served list, and the test fails if the declaration and the registry disagree.

Jelly's shared rules for every plugin of the family, word for word:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

## Skills

Two skills are declared and shipped in `skills/`: `inference-extract` (typed fields with nulls and evidence) and
`inference-decide` (bounded questions with exact probabilities and deterministic acceptance). Each is registered only
while its module (`extractions`, `decisions`) is on.

## Views and scripts

None: `jelly.views` and `jelly.rpc` are empty.

## Signing in

Nothing is required. `jelly.signIns` declares one optional sign-in, `openrouter`, labelled "OpenRouter key for
Inference": the plugin's own key integration `inference-openrouter` (`required: false`), with a link to where
OpenRouter keys are created, whose text (`help.label`) is "Create an OpenRouter API key. Inference sends the text, files
and artifacts you give it to OpenRouter." The label stays the name `/connect` shows, so a result's "Run /connect and
choose OpenRouter key for Inference" still opens the card; `/connect`'s key prompt reads "OpenRouter API key (text,
files and artifacts go to OpenRouter)". It is a separate key from OpenCode's own OpenRouter model provider and from the OpenRouter
plugin's "OpenRouter tools" sign-in, and `/connect` shows the same name.

The key is read for a call on an enabled route (`inference.extract` on `cloudflare/clairic`, `inference.decide` on
`typesafe/jev-1.14`), at dispatch, and sent only to OpenRouter, in one `Authorization` header. The three local tools never
read it, and status shows only whether it is connected. A key lasts until you remove or replace it in `/connect`.

## Versions

Jelly's curated catalogue pins an exact version. Each release is published under a new version, so a review in Jelly can
tell the two apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`. `scripts/check-copies.mjs` holds the kit, and the
shared part of the tools RPC (`src/host/tools-rpc.ts`), equal to the copy every plugin carries.
