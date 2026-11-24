# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.0.0 (unreleased)

### Added

- The plugin `inference.core`, with its TUI `inference.core.tui` (the **Inference: Status** dialog, `/inference`), the
  `inference` namespace, the status RPC `inference.core`, the tools RPC `inference.core.tools` for scripts, and
  `/inference-status`.
- Five tools from one registry, which also drives the tools RPC methods, the default permission rules, the Jelly
  declaration and the generated docs:
  - `inference_status`, `inference_capabilities` and `inference_plan` (class `read`): local, never calling a network
    service or reading a file or the key;
  - `inference_extract` (class `send`): named typed fields (text, number, date, time, datetime, list of text) from
    supplied text, a local file or an artifact, through OpenRouter's alpha Extractions API. Each field keeps its
    nullable value, evidence as Unicode code-point spans, the provider's confidence and null probability when reported
    (absent otherwise), a guess apart from the value, review reasons from deterministic checks, and a number exactly as
    written;
  - `inference_decide` (class `send`): noul, choice and score questions over text, inline or as a versioned question
    set, through OpenRouter's alpha Decisions API, with probabilities and distributions exactly as reported, the
    provider's confidence kept apart, per-question refusal and a deterministic acceptance.
- Two enabled routes, each verified by a compatibility canary against the live API on 2026-11-12:
  - `cloudflare/clairic` extractions, for text: USD 0.0000001 per input token, output free (OpenRouter's catalog);
  - `typesafe/jev-1.14` decisions, for noul, choice and score over text: USD 0.000000042 per input token, output free.
    A request above about 32 KB of state and questions is refused before sending (TypeSafe's default context limit).
- A capability fixture for `cloudflare/clairic`, `scaledown/extract`, `inception/mercury-decide`, `levanto/sage-2` and
  `typesafe/jev-1.14`, from OpenRouter's documentation and public catalog (canonical slugs, prices, the catalog check of
  2026-11-13). A route is enabled only with a passed canary naming its request and malformed-request reports and the
  wire revision it checked, and a price. ScaleDown, Mercury Decide and Sage are disabled. Catalog drift is reported and
  never enables a model.
- Strict wire contracts for both endpoints, from OpenRouter's API reference (`openrouter-alpha-extractions-2026-11-12.2`,
  `openrouter-alpha-decisions-2026-11-12.2`). An answer must come from the route's model id or its reviewed canonical
  slug, and a changed required field or type is `PROVIDER_CONTRACT_CHANGED`, never coerced. An enabled route runs only
  on the wire revision its canary checked; otherwise the call refuses with `ROUTE_NOT_VERIFIED`.
- Local refusals, before anything is read or sent: a disabled or unpriced route; a field type, question type or input a
  route does not take (Clairic's images and `duration` fields among them); a null threshold where the route takes none;
  more than 6 decimals; a one-option choice; Box questions; a request that may not fit the route's context.
- Two skills, `inference-extract` and `inference-decide`, shipped in the package and registered while their module is
  on; each teaches its tool's result: nulls, evidence, probabilities, review and cost.
- OpenCode `>=2.4.1 <2.5.0`, tested on 2.4.1. An older or newer host refuses with `HOST_UNTESTED` unless
  `allowUntestedHost` is set.

### Changed

- The plugin moved to `we-the-rebel-alliance/inference-plugin`: the package is
  `@we-the-rebel-alliance/inference-plugin` at `0.0.0`, and the changelog restarts here.
- Spend caps are opt-in: `spend.requestUsd`, `spend.sessionUsd` and `spend.rolling24hUsd` default to `null`, so a call
  runs at whatever it costs and each result reports that cost. A cap you set is a budget, not a price.
- `@opencode/plugin`, `@opencode/sdk` and `@opencode/client` are exact `2.4.1` devDependencies, with `effect` `4.1.0`.

### Removed

- The Jelly guide (`docs/jelly.md`) and the Jobs recipe (`docs/jobs.md`) with the Jobs and Utilities fixtures they ran.
  Scheduled reads are OpenCode automations; app guides live in each app's repository.
