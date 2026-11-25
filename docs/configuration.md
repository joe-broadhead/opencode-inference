# Configuration

The plugin's options live under the plugin's entry in `opencode.json`. Every option is validated when the plugin starts;
an invalid option is refused with `OPTIONS_INVALID` and every offending key named, never its value.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | How much the plugin's methods may do without asking. |
| `accounts` | object | — | One profile per account alias; a sign-in holds the OpenRouter key for that alias. |
| `allowUntestedHost` | boolean | `false` | Start outside the tested OpenCode range. |
| `modules` | object | — | Which operations are on. understanding is reserved and has no method in this version. |
| `profiles` | object | — | Task profiles, each naming a reviewed model. Setting it replaces the built-in profiles. |
| `limits` | object | — | The trusted limits a method input can only lower. |
| `spend` | object | — | The spend caps and the truthful-cost guards. |
| `data` | object | — | Data-handling options. |
| `questionSets` | object | — | Versioned question sets, by name, that decide may use instead of inline questions. |
| `acceptanceProfiles` | object | — | Versioned acceptance profiles, by name. review-first-v1 is built in. |
<!-- /generated:configuration -->

## Examples

One account, the defaults:

```json
{ "plugins": ["github:we-the-rebel-alliance/inference-plugin#v0.0.0"] }
```

Two accounts, asking before each send, with a per-call cap:

```json
{
  "plugins": [
    [
      "github:we-the-rebel-alliance/inference-plugin#v0.0.0",
      {
        "access": "ask-changes",
        "accounts": { "work": {}, "personal": {} },
        "spend": { "requestUsd": "0.05" }
      }
    ]
  ]
}
```

A task profile of your own, replacing the built-in profiles:

```json
{
  "profiles": {
    "invoice-text": { "model": "cloudflare/clairic" },
    "contract-text": { "model": "scaledown/extract" }
  }
}
```

## `access`

`all` (the default) runs reads and sends without asking. `ask-changes` runs every read and asks before each send.
`read-only` runs every read and refuses every send. The three reads — `status`, `probe`, `capabilities` and `plan` —
always run; `extract` and `decide` follow the level. The rules are generated into every agent's own permissions after
its base allow, so a later rule of your own still decides one method.

## `accounts`

A map of alias to profile. See [accounts](accounts.md). With no `accounts` option there is one `default` account.

## `modules`

`extractions` and `decisions` (both on) turn `extract` and `decide` on or off. A send whose module is off is refused
with `SOURCE_DISABLED` before a file is read or anything is sent. `understanding` is reserved: it changes what
`capabilities` and `plan` describe, and has no method in this version.

## `profiles`

A task profile names a reviewed model. `extract-typed`, `extract-pdf` and `decide-text` are built in; setting
`profiles` replaces them. The plan and the send name a profile or a model, never both.

## `limits`

- `concurrency` (2): provider calls in flight at once, 1 to 8.
- `maxFields` (32): the most fields or questions one call may name, up to the schema's 64.
- `deadlineMs` (60000): the deadline for one provider call, 1 second to 10 minutes.

A method input may lower `deadlineMs` and `maxEstimatedCostUsd`; it can never raise a trusted limit.

## `spend`

Every cap is opt-in and `null` by default, so no cap is set: each call still reports its cost.

- `requestUsd`: the most one call may reserve. An upper bound is reserved exactly; an estimate reserves the cap, which
  is then an admission limit, not a ceiling.
- `sessionUsd`: the most one session may spend, across settled, reserved and unknown-cost calls.
- `rolling24hUsd`: the most any rolling 24 hours may spend.
- `requirePricedRoute` (on): refuse a route with no price. This is a truthful-cost guard, not a cap.
- `requireUpperBound` (off): refuse a route whose price is only an estimate.

## `data` and `requireZdr`

`requireZdr: true` refuses a route that does not document zero data retention. It is off by default.

## `questionSets` and `acceptanceProfiles`

A versioned question set names questions once, in the trusted options, and `decide` may pass `questionSet` instead of
inline `questions`. Its name carries its version (`document-kind-v1`), and its exact questions are digested into every
result.

An acceptance profile is `review` or `automatic`. `review-first-v1` is built in and accepts nothing: every answer is
reviewed. An `automatic` profile accepts an answer only when it carries a held-out report for the same profile, model,
question set (by digest), adapter wire revision and thresholds; anything else turns the answer back to review. A label
is never a permission.

## Secrets

No key is a plugin option. An option whose name looks like a secret is refused with a pointer to `/connect`, and the
value is never echoed. Add OpenRouter keys as account sign-ins, not as configuration.
