# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The plugin shell: the plugin `inference.core`, its TUI `inference.core.tui`, the `inference` namespace, the status RPC `inference.core`, the tools RPC `inference.core.tools` and `/inference-status`.
- Three local tools, all `read` and none calling a network service: `inference_status`, `inference_capabilities` and `inference_plan`.
- One registry that drives the model tools, the tools RPC methods and classes, the default permission block, the Jelly declaration and the generated docs.
- Strict plugin-domain contracts, exported as JSON Schema: `SourceInput`, `ArtifactRef`, `EvidenceRef`, `Coverage`, `Usage`, `InferenceResult` and the extract, decide, read and plan inputs.
- Strict options (`access`, `modules`, `profiles`, `routing`, `limits`, `spend`, `data`, `cache`, `allowUntestedHost`); a key-like option is refused.
- The plugin-owned `/connect` entry "OpenRouter for Inference" (`inference-openrouter`). Status reports only whether it is connected; this version never reads the key.
- A dated, documentation-derived capability fixture for `cloudflare/clairic`, `scaledown/extract`, `inception/mercury-decide`, `levanto/sage-2` and `typesafe/jev-1.14`, with every route disabled and no prices.
- The operation runtime, wired into the one dispatcher for both host surfaces but reached by no registered tool yet: the ordered pipeline of handoff §7, approved local file reads through a descriptor into immutable snapshots, the OpenRouter transport boundary, a private operation journal with a process mutex and a cross-process lock that is never taken over, operation-keyed reservations at the request, session and rolling 24-hour scopes, and settlement that keeps the reservation when the cost is unknown.
- Failure codes for operations: `CAPABILITY_UNSUPPORTED`, `UNSAFE_PATH`, `SOURCE_CHANGED`, `SOURCE_TYPE`, `SOURCE_LIMIT`, `CONTEXT_LIMIT`, `AUTH_REQUIRED`, `AUTH_REJECTED`, `PRICE_UNKNOWN`, `BUDGET_EXCEEDED`, `JOURNAL_LOCKED`, `JOURNAL_UNREADABLE`, `PROVIDER_ERROR`, `PROVIDER_CONTRACT_CHANGED`, `SUBMISSION_UNKNOWN` and `DEADLINE_EXCEEDED`.

- `inference_extract` (class `send`) with the OpenRouter alpha Extractions adapter: nullable typed fields, evidence as Unicode code-point spans, lists with per-item evidence, reported confidence and null probability kept absent when not reported, diagnostic guesses kept apart from values, deterministic checks as review reasons, a strict consumed-response schema (`PROVIDER_CONTRACT_CHANGED` on a changed field or type), exact usage read from the answer's literal and rounded up, and an exact quote. Every route stays disabled until its compatibility canary passes.
- A per-field `nullThreshold`, refused locally where the route does not take it (Clairic lists, ScaleDown, unknown support); Clairic's image limits enforced locally.
- Catalog drift as a compatibility status that never enables a model, and a per-route canary status the fixture requires before a route can be enabled.
- `scripts/canary-extractions.ts`: the opt-in live canary (text, image, PDF, malformed request, catalog), refusing without an explicit key, budget and acknowledgement.

- `inference_decide` (class `send`) with the OpenRouter alpha Decisions adapter: noul, choice and score questions over text; probabilities and distributions exactly as reported (never renormalised, rounded or completed); the provider's confidence kept apart; per-question refusal; Box and images refused locally; the route's effective context enforced by refusing, never truncating. Every route stays disabled until its canary passes.
- Versioned question sets and acceptance profiles in the trusted options (`questionSets`, `acceptanceProfiles`): deterministic acceptance, `review-first-v1` built in, and automatic profiles that load only with a matching held-out report.
- `scripts/evaluate-decisions.ts`: held-out reports from labelled cases and recorded answers, split by document.
- `scripts/canary-decisions.ts`: the opt-in Decisions canary (catalog, text, malformed request).

### Changed

- Status lists an agent as unguarded when its own rules would run any non-read Inference action without asking, registered or planned, not only the planned ones.
- `npm run lint` checks the network and key boundary with the TypeScript compiler API: outside the transport boundary modules are an allow-list (relative paths inside `src/`, listed `node:` builtins and packages); `eval`, `Function`, prototype and property-definition routes, network globals, loader escapes, `process` beyond a few members, computed keys the type checker cannot prove safe, and any use of the host connection API other than a direct method call that is not `resolve` are refused; `dist/` may hold only `src/` and inlined zod. It catches accidental and casual network use; review and the runtime network spy cover deliberate evasion.
