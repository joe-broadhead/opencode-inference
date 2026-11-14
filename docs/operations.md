# Operating Inference

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

What a result means, what it costs, what leaves the machine, how routes are verified and refreshed, and what to do when
a call fails. The option reference is [configuration.md](configuration.md); the design is
[architecture.md](architecture.md).

## Status of this version

A route is enabled only after its compatibility canary has passed against the live API, with the reports and the wire
revision it passed against recorded in the fixture, and its price taken from OpenRouter's public catalog.
`inference_capabilities` lists which routes are enabled and what each takes. On a disabled route, `inference_extract`
and `inference_decide` refuse with `CAPABILITY_UNSUPPORTED` before reading a file, resolving the key or sending
anything. Enabling a route is a reviewed change, one route at a time (see [Refreshing the fixture](#refreshing-the-fixture)).

## Uncertainty

- **A null is a result.** A field the source does not state is `null`; a provider's `guess` is diagnostic and never
  fills it. A refused decision is `refused`: not false, not zero.
- **Confidence is not acceptance.** A provider's confidence, null probability or distribution is a model statistic, not
  verified correctness, and an absent one is not zero. What a person must check is `review.required` and the reasons:
  under the built-in `review-first-v1`, every result is reviewed.
- **Probabilities are kept exactly.** Decision probabilities and distributions are the provider's exact decimals; a
  distribution is never renormalised or completed, and an unreported label is unknown. Acceptance treats unreported
  mass as a possible runner-up and never accepts a tie.
- **Automatic acceptance needs evidence.** A profile accepts answers only with a held-out report for the same profile,
  model, question set, adapter revision and thresholds, and a false-accept rate the task tolerates. The report is
  unauthenticated JSON in the trusted options: review a change to it like code.
- **Coverage says what was read.** `complete` covers the declared source representation, not every fact in it;
  `partial` or `PROVIDER_TRUNCATED` means some of it was not read; `unknown` is honest for a file the provider read
  natively.
- **Evidence is exact or absent.** Text spans are Unicode code points of the exact text sent, with the span's hash; an
  item without a span keeps an empty list rather than an invented offset.

## Cost scope

- No spend cap is set by default: a call runs at whatever it costs, and each result reports that cost. Every cap is
  opt-in. Each call reserves before it sends: the route's documented ceiling when one exists, otherwise the whole
  per-request budget when you set one, or the top of the estimate when you did not (an estimate is never a ceiling).
  Session and rolling 24-hour caps, when set, count settled charges, reservations in flight, and reservations kept for
  unknown costs. Details: [configuration.md](configuration.md#spend).
- **Unknown is not free.** A call that may have been sent and has no reported cost keeps its reservation. Do not retry
  it blindly: `SUBMISSION_UNKNOWN`, and a deadline or a cancellation after sending, mean the provider may have run and
  charged it.
- A cap you set covers this machine's journal for one OpenRouter connection. They are not account-wide; OpenRouter's own
  key limits are the stronger, independent cap. Give the key a credit limit.
- The spend caps default to none (`null`). A cap you set is a budget, not a price: what a call costs is the provider's
  reported charge.

## Privacy

- **What is sent:** to `https://openrouter.ai` only, the source's text (or one image or PDF), the field or question
  definitions, an extraction's `referenceDate` (as `reference_date`) when given, the model id and
  `provider.allow_fallbacks: false`, with the key in the `Authorization` header. Nothing
  else leaves the machine, and nothing is sent to a disabled route.
- **What the provider keeps** is the provider's policy, not this plugin's. `data.requireZdr: true` makes a route without
  documented zero data retention ineligible; `false` asserts nothing.
- **What is kept locally:** the operation journal (a 0700 folder, a 0600 file) holds hashes, ids, the route, timing,
  amounts and error codes, never a key, source text, request or response body, or URL. Terminal records leave after 30
  days; unsettled ones stay.
- **Permissions:** reading a file asks the host (`read`, and `external_directory` outside the project, by the real
  folder) before any byte is read. A result never authorizes anything: a label or an accepted answer is not a
  permission.

## Refreshing the fixture

`src/providers/openrouter/capabilities.ts` is a dated, documentation-derived description of each route. A route goes
live only through a reviewed change, in this order:

1. Run the opt-in canary for the route (`scripts/canary-extractions.ts`, `scripts/canary-decisions.ts`) with a dedicated
   key, a small budget and a per-call worst case: the request canary and the malformed-request canary. It reports
   catalog drift, contract compatibility and reported costs, names the wire revision it checked and the commit it ran
   from, and never edits the fixture.
2. Record what was verified: the route's `canary` (`passed`, the date, `reports: { request, malformed }` by file name,
   both from the route's endpoint, and the `wireRevision`), its prices (`pricing`, with a documented `ceiling` and its
   source if a per-token price is to be an upper bound), for Decisions its reviewed `effectiveContextTokens` and
   documented `contextAllowance`, the catalog check (`catalog.checkedOn`), `reviewedOn`, and a new fixture `revision`.
3. Only then set `enabled: true`. The fixture's schema refuses an enabled route without that evidence, and at run time a
   route whose recorded `wireRevision` is not its adapter's refuses with `ROUTE_NOT_VERIFIED`: an adapter change needs
   a new canary.

A fixture older than 30 days is reported stale by status and capabilities. A new model in OpenRouter's catalog is a
disabled candidate, never enabled by being listed.

## Alpha compatibility

The Extractions and Decisions endpoints are alpha. Each adapter pins a wire revision (`WIRE_REVISION` in
`extractions.ts` and `decisions.ts`), part of every request fingerprint and of every held-out report.

- An answer that changes a required field or type is refused as `PROVIDER_CONTRACT_CHANGED`, never coerced; harmless
  unknown metadata is ignored and counted in coverage warnings.
- When that happens: stop using the route, run its canary, update the adapter and its fixtures under a new wire
  revision, and re-evaluate any automatic profile (its report names the old revision, so it reviews until then).
- The response shapes the adapters expect follow OpenRouter's API reference; for each enabled route, its canary checked
  them against the live API at the recorded wire revision.

## Common errors

| Code | What it usually means | What to do |
| --- | --- | --- |
| `CAPABILITY_UNSUPPORTED` | The route is disabled, or the request needs something it does not take. | Read the message; check routes with `inference_capabilities` or `inference_plan`. Do not switch tools to get around it. |
| `ROUTE_NOT_VERIFIED` | The route's canary passed against another wire revision than this version's adapter. | Nothing was read or sent. Re-run the canary for this revision; a reviewed change records the new pass. |
| `PRICE_UNKNOWN` | No price is known and the spend options require one. | Wait for a priced route, or change the trusted spend options deliberately. |
| `BUDGET_EXCEEDED` | The reservation would pass the request, session or 24-hour budget. | Wait for the window, or raise the trusted limit. |
| `AUTH_REQUIRED` / `AUTH_REJECTED` | No usable OpenRouter key for Inference. | `/connect` and choose OpenRouter key for Inference. |
| `UNSAFE_PATH` / `SOURCE_CHANGED` / `SOURCE_TYPE` / `SOURCE_LIMIT` | The file is not a plain approved file, changed after approval, is not the type it claims, or is too large. | Re-select the current regular file, or a smaller one. |
| `CONTEXT_LIMIT` | The request may not fit the route. | Shorten or split the source deliberately; nothing is truncated silently. |
| `SUBMISSION_UNKNOWN` / `DEADLINE_EXCEEDED` / `CANCELLED` after sending | The call may have reached OpenRouter; its reservation is kept. | Do not resubmit blindly; report the operation id. |
| `PROVIDER_CONTRACT_CHANGED` | The answer did not match the reviewed contract. | Stop using the route; see [Alpha compatibility](#alpha-compatibility). |
| `JOURNAL_LOCKED` | Another process holds the journal's lock, or one crashed holding it. | Make sure no other OpenCode uses Inference, then remove the named lock file. |
| `PERMISSION_DENIED` | A script's agent would be asked, or is denied. | Add an allow rule for the action to the script's agent. |

Every code, with its exact text, is in [configuration.md](configuration.md#errors).
