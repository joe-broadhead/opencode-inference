# Inference plugin

Unofficial OpenCode plugin. Not affiliated with OpenCode, and not affiliated with OpenRouter.

OpenRouter is a trademark of OpenRouter, Inc.; this unofficial plugin is not endorsed by them.

`@we-the-rebel-alliance/inference-plugin` adds typed extraction (`tools.inference.extract`) and bounded decisions
(`tools.inference.decide`) through OpenRouter's alpha Extractions and Decisions APIs, keeping nulls, evidence,
probabilities, refusals, coverage and cost in every result. **A route is enabled only after a compatibility canary has
verified it against the live API**; a disabled route refuses with that reason and nothing is sent.
`tools.inference.capabilities` lists the enabled routes and what each takes. The text, files and artifacts you give
`tools.inference.extract` and `tools.inference.decide` go to OpenRouter; the three local tools send nothing.

## What works in this version

- **`tools.inference.status`**: whether the OpenRouter key is connected (never the key), which modules are on, the
  capability fixture's date, the spend caps you set (none by default), which actions ask for permission, and one next
  step.
- **`tools.inference.capabilities`**: what this version implements, and what each reviewed route documents (inputs,
  field and question types, limits, price if known) with every reason it cannot run.
- **`tools.inference.plan`**: given `{ task, input }` for an extract, decide or read call, the route and its exclusion
  reasons, the local preparation it would need, what would be sent and where, a quote, expected coverage, likely review
  and the unknowns. It never opens a file, uploads, calls a provider or spends. A plan is not a permission.
- **`tools.inference.extract`** (`send`): named typed fields (text, number, date, time, datetime, list of text; a
  duration is refused on OpenRouter in this version) from supplied text, a local file or an artifact, on an enabled
  route. Each field keeps its nullable value (a guess never fills it), the provider's confidence and null probability
  when reported, evidence as Unicode code-point spans of the exact source, review reasons, and the number exactly as
  written. It asks the host before reading a file, reserves budget before sending, and refuses provider constraints
  locally. On a disabled route it refuses before reading or sending anything.
- **`tools.inference.decide`** (`send`): noul (the probability a proposition is true), choice and score (the expected
  position on an ordered rubric) questions about supplied text, given inline or as a versioned question set from the
  trusted options. Probabilities and distributions come back exactly as reported (never renormalised or completed),
  the provider's confidence apart, and a refusal as its own outcome. A deterministic acceptance profile marks each
  answer accepted, review or refused: the built-in `review-first-v1` accepts nothing. An accepted label is never a
  permission.
- Two skills, `inference-extract` and `inference-decide`, teach agents when to use each tool and how to read its result
  (nulls, evidence, probabilities, review, cost). Each is registered while its module is on.
- `/inference-status` in a session, and the **Inference: Status** dialog (`/inference`) in the TUI.
- Scripts call the same tools with no model through the tools RPC `inference.core.tools`
  ([docs/scripting.md](docs/scripting.md)).

A route is enabled only after its opt-in canary (`scripts/canary-extractions.ts`, `scripts/canary-decisions.ts`, which
need an explicit key and budget and are never run by the checks) has passed against it. A disabled route has no price,
so its quote is `unavailable`.

<!-- generated:tools -->

| Tool | Host tool and permission | Code Mode | Tools RPC method | Class | Network | Uploads source | Billable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `inference.status` | `inference_status` | `tools.inference.status(input)` | `inference.core.tools/status` | read | no | no | no |
| `inference.capabilities` | `inference_capabilities` | `tools.inference.capabilities(input)` | `inference.core.tools/capabilities` | read | no | no | no |
| `inference.plan` | `inference_plan` | `tools.inference.plan(input)` | `inference.core.tools/plan` | read | no | no | no |
| `inference.extract` | `inference_extract` | `tools.inference.extract(input)` | `inference.core.tools/extract` | send | yes | yes | yes |
| `inference.decide` | `inference_decide` | `tools.inference.decide(input)` | `inference.core.tools/decide` | send | yes | yes | yes |

<!-- /generated:tools -->

## Requirements

<!-- generated:hosts -->

OpenCode `>=2.4.1 <2.5.0`, tested on 2.4.1.

<!-- /generated:hosts -->

Another OpenCode refuses to start the plugin with `HOST_UNTESTED`, unless the option `allowUntestedHost` is set.

## Install

```sh
opencode plugin add github:we-the-rebel-alliance/inference-plugin
opencode reload
```

Or add it to `opencode.json`:

```json
{
  "plugins": [{ "package": "github:we-the-rebel-alliance/inference-plugin" }]
}
```

The install tracks `master` until the first release. A Git install does not update by itself: remove the entry with
`opencode plugin remove github:we-the-rebel-alliance/inference-plugin`, then add it again.

## Connect OpenRouter

Run `/connect` and choose **OpenRouter key for Inference**, then enter an OpenRouter API key, or run
`opencode auth login inference-openrouter`. This is the plugin's own key, separate from OpenCode's OpenRouter model
provider. The plugin stores no key itself: the transport reads it at dispatch, only for an enabled route, and sends it
only to OpenRouter in the `Authorization` header. Status shows only connected or not connected. The key is needed only
for an enabled route; the three local tools never need it. Several named accounts arrive with the plugin contract in a
later release; this version has the one key.

## Configure

Options go in the plugin's entry in `opencode.json`. Every option is optional and the plugin refuses unknown ones;
keys are never options. See [docs/configuration.md](docs/configuration.md) for each option, the default permission
rules for each `access` value, and the error codes.

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/inference-plugin",
      "options": { "access": "ask-changes", "limits": { "maxFields": 16 } }
    }
  ]
}
```

## Permissions

The plugin inserts a default block after each agent's base allow: the three local reads always run, and
`inference_extract` and `inference_decide` follow `access` (`all` allows them, `ask-changes` asks, `read-only` denies).
Every call asserts its tool's own action first, so that holds for a text source as much as for a file. Reading a file
also asks the host's own `read` (and `external_directory` outside the project). Your own rules still win.

## Documentation

- [docs/operations.md](docs/operations.md): uncertainty, cost scope, privacy, refreshing the fixture, alpha
  compatibility and common errors.
- [docs/architecture.md](docs/architecture.md): the layers, the registry, the reserved operations and the fixture.
- [docs/configuration.md](docs/configuration.md): options, permissions and errors.
- [docs/scripting.md](docs/scripting.md): the tools RPC, and scheduled reads as an OpenCode automation.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup and checks.

## Known limits

- **Two routes are enabled**, each after a compatibility canary against the live API on 2026-11-12:
  - `cloudflare/clairic` extraction, **text only**. Its images are documented but not enabled, and it takes no PDF.
  - `typesafe/jev-1.14` decisions: **noul, choice and score over text**. A request whose state and questions exceed
    about 32 KB is refused before anything is sent. Box questions and images are not enabled.
- **Everything else is disabled.** A disabled route refuses before reading or sending anything.
- **Every answer goes to review.** The built-in `review-first-v1` profile accepts nothing: a provider's confidence is
  its own statistic, not checked accuracy.
- **Spend.** No cap is set by default: `spend.requestUsd`, `spend.sessionUsd` and `spend.rolling24hUsd` are `null`, so a
  call runs at whatever it costs, and each result reports that cost. A cap you set counts this machine's journal for one
  connection, not your whole OpenRouter account, so give the key its own credit limit too.
- **Alpha endpoints.** OpenRouter's Extractions and Decisions APIs are alpha and may change. An answer that no longer
  matches the reviewed contract is refused (`PROVIDER_CONTRACT_CHANGED`), and an adapter change disables its route
  until a new canary passes for the new revision (`ROUTE_NOT_VERIFIED`).

## License

MIT. `dist/index.js` bundles zod; see [NOTICE](NOTICE).
