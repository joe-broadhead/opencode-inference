# OpenCode Inference

Unofficial OpenCode plugin. Not affiliated with OpenCode or OpenRouter.

**Not released yet.** `@joe-broadhead/opencode-inference` offers typed extraction (`inference.extract`) and bounded
decisions (`inference.decide`) through OpenRouter's alpha Extractions and Decisions APIs, keeping nulls, evidence,
probabilities, refusals, coverage and cost in every result. **Every route is disabled** until a compatibility canary
has verified it against the live API, so in this version both tools refuse with that reason and nothing is sent.

## What works in this version

- **`inference_status`**: whether the OpenRouter key is connected (never the key), which modules are on, the capability
  fixture's date, the spend limits, which actions ask for permission, and one next step.
- **`inference_capabilities`**: what this version implements, and what each reviewed route documents (inputs, field and
  question types, limits, price if known) with every reason it cannot run.
- **`inference_plan`**: given `{ task, input }` for an extract, decide or read call, the route and its exclusion reasons,
  the local preparation it would need, what would be sent and where, a quote, expected coverage, likely review and the
  unknowns. It never opens a file, uploads, calls a provider or spends. A plan is not a permission.
- **`inference_extract`** (`send`): named typed fields (text, number, date, time, datetime, duration, list of text) from
  supplied text, a local file or an artifact, on an enabled route. Each field keeps its nullable value (a guess never
  fills it), the provider's confidence and null probability when reported, evidence as Unicode code-point spans of the
  exact source, review reasons, and the number exactly as written. It asks the host before reading a file, reserves
  budget before sending, and refuses provider constraints locally (no null threshold on a Clairic list or on ScaleDown,
  Clairic's image limits). With every route disabled, it refuses before reading or sending anything.
- **`inference_decide`** (`send`): noul (the probability a proposition is true), choice and score (the expected,
  possibly fractional, position on an ordered rubric) questions about supplied text, given inline or as a versioned
  question set from the trusted options. Probabilities and distributions come back exactly as reported (never
  renormalised or completed), the provider's confidence apart, and a refusal as its own outcome. A deterministic
  acceptance profile marks each answer accepted, review or refused: the built-in `review-first-v1` accepts nothing, and
  an automatic profile is accepted by the options only with a held-out report for the same model, question set and
  thresholds. An accepted label is never a permission. Box questions are refused, and a request that may not fit the
  route's effective context is refused rather than truncated.
- Two skills, `inference-extract` and `inference-decide`, teach agents when to use each tool and how to read its result
  (nulls, evidence, probabilities, review, cost). Each is registered while its module is on.
- `/inference-status` in a session, and the **Inference: Status** dialog (`/inference`) in the TUI.
- Scripts call the same tools with no model through the tools RPC `inference.core.tools`
  ([docs/scripting.md](docs/scripting.md)).

Every route in the capability fixture is disabled: the fixture is transcribed from public documentation (dated
2026-11-11), not verified against the live API, and records no prices, so every quote is `unavailable`. A route is
enabled only after its opt-in canary (`scripts/canary-extractions.ts`, `scripts/canary-decisions.ts`, which need an
explicit key and budget and are
never run by the checks) has passed against it.

<!-- generated:tools -->

| Tool | Host tool and permission | Code Mode | Tools RPC method | Jobs manifest | Class | Network | Uploads source | Billable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `inference.status` | `inference_status` | `tools.inference.status(input)` | `inference.core.tools/status` | `inference.core.status` | read | no | no | no |
| `inference.capabilities` | `inference_capabilities` | `tools.inference.capabilities(input)` | `inference.core.tools/capabilities` | `inference.core.capabilities` | read | no | no | no |
| `inference.plan` | `inference_plan` | `tools.inference.plan(input)` | `inference.core.tools/plan` | `inference.core.plan` | read | no | no | no |
| `inference.extract` | `inference_extract` | `tools.inference.extract(input)` | `inference.core.tools/extract` | `inference.core.extract` | send | yes | yes | yes |
| `inference.decide` | `inference_decide` | `tools.inference.decide(input)` | `inference.core.tools/decide` | `inference.core.decide` | send | yes | yes | yes |

<!-- /generated:tools -->

## Requirements

<!-- generated:hosts -->

OpenCode `>=2.2.3 <2.3.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6.

<!-- /generated:hosts -->

## Install

Not published. To try a checkout, run `npm ci --ignore-scripts && npm run build`, then point a `plugins` entry in
`opencode.json` at the repository directory.

## Connect OpenRouter (optional in this version)

Run `/connect` and choose **OpenRouter for Inference**, then enter an OpenRouter API key, or run
`opencode auth login inference-openrouter`. This entry belongs to the plugin and is separate from OpenCode's own
OpenRouter model provider. The plugin stores no key itself: the transport reads it at dispatch, only for an enabled
route, and sends it only to OpenRouter in the `Authorization` header. Status shows only connected or not connected. No
key is needed for the three local tools.

## Configure

Options go in the plugin's entry in `opencode.json`. Every option is optional and the plugin refuses unknown ones;
keys are never options. See [docs/configuration.md](docs/configuration.md) for each option, the default permission
rules for each `access` value, and the error codes.

```json
{
  "plugins": [
    {
      "package": "@joe-broadhead/opencode-inference",
      "options": { "access": "ask-changes", "limits": { "maxFields": 16 } }
    }
  ]
}
```

## Permissions

The plugin inserts a default block after each agent's base allow: the three local reads always run, and
`inference_extract` and the `inference_*` pattern follow `access` (`all` allows them, `ask-changes` asks, `read-only`
denies). Reading a file also asks the host's own `read` (and `external_directory` outside the project). Your own rules
still win.

## Documentation

- [docs/operations.md](docs/operations.md): uncertainty, cost scope, privacy, refreshing the fixture, alpha
  compatibility and common errors.
- [docs/jobs.md](docs/jobs.md): a Jobs recipe (an invoice's due date), tested on a real host.
- [docs/architecture.md](docs/architecture.md): the layers, the registry, the reserved operations and the fixture.
- [docs/configuration.md](docs/configuration.md): options, permissions and errors.
- [docs/scripting.md](docs/scripting.md): the tools RPC.
- [docs/jelly.md](docs/jelly.md): the Jelly declaration.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup and checks.

## License

MIT. `dist/index.js` bundles zod; see [NOTICE](NOTICE).
