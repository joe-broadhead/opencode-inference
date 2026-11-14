# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.2] - 2026-11-14

### Changed

- **Spend caps are opt-in.** `spend.requestUsd`, `spend.sessionUsd` and `spend.rolling24hUsd` now default to `null`:
  no cap is set, so a call is never refused for its price, and each result still reports what it cost. This reverses
  the default caps of 0.0.0 and 0.0.1 (USD 0.05 per request, 1.00 per session, 5.00 per rolling 24 hours), to match
  the family's default that everything is allowed until you add a limit. A cap you set works exactly as before. With
  no per-request cap, a call reserves the top of its estimate, and an unpriced call is refused while a session or
  rolling cap is set. `spend.requirePricedRoute` stays on. Status names only the caps that are set.
- **The connection is named "OpenRouter key for Inference"**, in `/connect` and in Jelly (its Jelly label was
  "OpenRouter"), so it can be told apart from OpenCode's OpenRouter model provider and the OpenRouter plugin's
  "OpenRouter tools" sign-in. Its integration id, `inference-openrouter`, is unchanged, so a connected key stays
  connected.
- Jelly: `docs/jelly.md` said the key is never read. It is read for a call on an enabled route, at dispatch, and sent
  only to OpenRouter; the local tools never read it. The source comment that said no registered tool reached it is
  corrected too.

## [0.0.1] - 2026-11-13

### Added

- The `jelly` settings declare their choices: `access` offers Jelly's three (Allowed, Ask before changes, Read only),
  generated from the access values with the rest of the declaration, so Jelly draws it as a choice instead of free text.
  A test reads the settings with Jelly's setting schema and checks that the options parser takes every declared value
  and refuses one outside the set (needs a jelly that includes app#1301).
- The README says how to move to a newer release: remove the old tag's entry, then add the new tag.

## [0.0.0] - 2026-11-13

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
- Acceptance: `review-first-v1` built in (every answer is reviewed), and automatic profiles in the trusted options
  (`questionSets`, `acceptanceProfiles`) that load only with a matching held-out report.
- Spend control: a reservation before each call (the whole per-request budget when a price has no documented ceiling),
  request, session and rolling 24-hour budgets (`spend.requestUsd` 0.05, `spend.sessionUsd` 1.00,
  `spend.rolling24hUsd` 5.00, in USD), and a private operation journal that keeps a reservation when the cost is unknown
  and never resubmits a call that may have been sent.
- Strict options (`access`, `modules`, `profiles`, `routing`, `limits`, `spend`, `data`, `cache`, `allowUntestedHost`);
  a key-like option is refused.
- The plugin-owned `/connect` entry "OpenRouter for Inference" (`inference-openrouter`). The key is read at dispatch,
  only for a call on an enabled route, and sent only to OpenRouter; status shows only whether it is connected and
  whether an enabled route needs it.
- Default permission rules for each `access` value; a file read is asked of the host before any byte is read; status
  names every agent whose own rules would run a non-read Inference action without asking.
- Failure codes with a next step for every refusal, listed in docs/configuration.md.
- The `inference-extract` and `inference-decide` skills, registered per module; a missing or malformed skill is skipped
  with `SKILLS_INVALID` in status.
- Documentation: configuration, scripting, operations (uncertainty, cost scope, privacy, refreshing the fixture, alpha
  compatibility, common errors), architecture, Jelly, and a Jobs recipe tested through the released Jobs plugin.
- Opt-in scripts the checks never run: `scripts/canary-extractions.ts` and `scripts/canary-decisions.ts` (catalog,
  request and malformed-request canaries; they refuse without an explicit key, budget and acknowledgement; `--shape`
  records an answer's structure, never its values; every report names its wire revision and commit), and
  `scripts/evaluate-decisions.ts` (held-out reports from labelled cases).

### Security

- Only the OpenRouter transport (`src/providers/openrouter/http.ts`) reaches the network or resolves the key: one
  trusted origin, two reviewed paths, the key in one `Authorization` header, no redirects followed. `npm run lint`
  checks that boundary with the TypeScript compiler API: elsewhere modules are an allow-list, and network globals,
  string-evaluated code, loader escapes, prototype and property-definition routes, computed keys the type checker
  cannot prove safe, and any use of the host connection API other than a direct method call are refused; `dist/` may
  hold only `src/` and inlined zod. It catches accidental and casual network use; review and the runtime network spy
  cover deliberate evasion.
