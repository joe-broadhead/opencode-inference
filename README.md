# OpenCode Inference

Unofficial OpenCode plugin. Not affiliated with OpenCode or OpenRouter.

**Not released yet.** This is the first stage of `@joe-broadhead/opencode-inference`: the plugin shell, its registry,
status and a local planner. It extracts nothing and decides nothing yet, and it calls no network service.

The plugin will offer typed extraction (`inference.extract`) and bounded decisions (`inference.decide`) over supplied
content, through OpenRouter's alpha Extractions and Decisions APIs first, keeping nulls, evidence, coverage, uncertainty
and cost in every result. Those tools are reserved names in this version, not tools.

## What works in this version

- **`inference_status`**: whether the OpenRouter key is connected (never the key), which modules are on, the capability
  fixture's date, the spend limits, which actions ask for permission, and one next step.
- **`inference_capabilities`**: what this version implements, and what each reviewed route documents (inputs, field and
  question types, limits, price if known) with every reason it cannot run.
- **`inference_plan`**: given `{ task, input }` for an extract, decide or read call, the route and its exclusion reasons,
  the local preparation it would need, what would be sent and where, a quote, expected coverage, likely review and the
  unknowns. It never opens a file, uploads, calls a provider or spends. A plan is not a permission.
- `/inference-status` in a session, and the **Inference: Status** dialog (`/inference`) in the TUI.
- Scripts call the same three tools with no model through the tools RPC `inference.core.tools`
  ([docs/scripting.md](docs/scripting.md)).

All three tools are `read`. Every route in the capability fixture is disabled: the fixture is transcribed from public
documentation (dated 2026-11-11), not verified against the live API, and records no prices, so every quote is
`unavailable`.

<!-- generated:tools -->

| Tool | Host tool and permission | Code Mode | Tools RPC method | Jobs manifest | Class | Network | Uploads source | Billable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `inference.status` | `inference_status` | `tools.inference.status(input)` | `inference.core.tools/status` | `inference.core.status` | read | no | no | no |
| `inference.capabilities` | `inference_capabilities` | `tools.inference.capabilities(input)` | `inference.core.tools/capabilities` | `inference.core.capabilities` | read | no | no | no |
| `inference.plan` | `inference_plan` | `tools.inference.plan(input)` | `inference.core.tools/plan` | `inference.core.plan` | read | no | no | no |
| `inference.extract` | `inference_extract` | `tools.inference.extract(input)` | `inference.core.tools/extract` | `inference.core.extract` | send | yes | yes | yes |

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
OpenRouter model provider. This version stores nothing itself and never reads the key; status shows only connected or
not connected. No key is needed for the three local tools.

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

The plugin inserts a default block after each agent's base allow: the three local reads always run, and the
`inference_*` pattern covers the send tools a later release adds (`all` allows them, `ask-changes` asks, `read-only`
denies). Your own rules still win.

## Documentation

- [docs/architecture.md](docs/architecture.md): the layers, the registry, the reserved operations and the fixture.
- [docs/configuration.md](docs/configuration.md): options, permissions and errors.
- [docs/scripting.md](docs/scripting.md): the tools RPC.
- [docs/jelly.md](docs/jelly.md): the Jelly declaration.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup and checks.

## License

MIT. `dist/index.js` bundles zod; see [NOTICE](NOTICE).
