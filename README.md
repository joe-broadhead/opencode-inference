# Inference

An OpenCode plugin on the plugin contract. It adds typed extraction (`tools.inference.extract`) and bounded decisions
(`tools.inference.decide`) through OpenRouter's alpha Extractions and Decisions APIs, keeping nulls, evidence,
probabilities, refusals, coverage and cost in every result. `status`, `probe`, `capabilities` and `plan` are local and
spend nothing. `extract` and `decide` send the source through the account's OpenRouter key and can be charged, and only
on a verified, enabled route: a disabled route refuses before reading a file, resolving the key or sending anything.

Unofficial plugin: not affiliated with OpenCode, and not affiliated with OpenRouter. OpenRouter is a trademark of
OpenRouter, Inc.; this unofficial plugin is not endorsed by them.

## Install

```sh
opencode plugin add github:we-the-rebel-alliance/inference-plugin#v<version>
```

The first release is v0.0.0. Pin an exact tag: `master` builds nothing and is not an install target.

## Sign in

The plugin holds one OpenRouter API key per account, as an OpenCode integration. With one account, run `/connect` and
choose **Inference**, then paste a key from <https://openrouter.ai/settings/keys>. The key is read only when a send
method runs on an enabled route, and is sent only to `https://openrouter.ai`.

## Accounts

Several accounts can be signed in at once. Declare them in the plugin options and sign each one in:

```json
{ "accounts": { "work": {}, "personal": {} } }
```

- `work` signs in to the integration **Inference (work)**, whose id is `inference-work`.
- `personal` signs in to **Inference (personal)**, whose id is `inference-personal`.
- With no `accounts` option there is one `default` account, signed in to the integration **Inference** (`inference`).

Every method that uses the key takes `account` (`extract`, `decide`, `probe`). With one account it may be left out; with
several, leaving it out is `ACCOUNT_REQUIRED`, whose next step lists the aliases. An unknown alias is `ACCOUNT_UNKNOWN`.
See [docs/accounts.md](docs/accounts.md).

## Access

`access` is `all` (the default), `ask-changes` or `read-only`, and is generated into every agent's rules:

- **Reads** — `status`, `probe`, `capabilities` and `plan` — always run. They read no key and send nothing.
- **Sends** — `extract` and `decide` — run under `all`, ask first under `ask-changes`, and are refused under `read-only`.
- A choice the person makes for one method wins, and an agent that lacks the generated rules is named in `status`.

## What it does

- **`tools.inference.status`** — the OpenCode range, every account alias and whether it is signed in, the agents
  without the generated rules, and one next step. It never reads a key.
- **`tools.inference.probe`** — whether OpenCode holds a usable key for one alias. It reads no content and never the key.
- **`tools.inference.capabilities`** — what this version implements and what each reviewed route documents: inputs,
  field and question kinds, limits, price when known, and every reason it cannot run now. The data is a dated,
  documentation-derived fixture; nothing is refreshed or called.
- **`tools.inference.plan`** — given `{ task, input }`, the route and its exclusions, the preparation it would need,
  what would be sent and where, a quote, expected coverage, likely review and the unknowns. It never opens a file,
  uploads, calls a provider or spends. A plan is not a permission.
- **`tools.inference.extract`** (`send`) — named typed fields from supplied text, a local file or an artifact: a
  nullable value, the provider's confidence and null probability when reported, evidence as Unicode code-point spans of
  the exact source, the number exactly as written, review reasons, coverage and usage.
- **`tools.inference.decide`** (`send`) — noul (the probability a proposition is true), choice and score (the expected
  position on an ordered rubric) answers with their probability or distribution exactly as reported, per-question
  refusal, and a deterministic acceptance. An accepted label is never a permission.

Every send asks the host before reading a file, reserves the budget before sending, and reports what the call cost.
A route is enabled only in a reviewed change after its compatibility canary has passed; a disabled route refuses with
`CAPABILITY_UNSUPPORTED` and sends nothing. The `read` operation is reserved: it is described by `capabilities` and
`plan` and has no method in this version.

## Capabilities

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | — |
| `probe` | read | optional | — |
| `capabilities` | read | none | — |
| `plan` | read | none | — |
| `extract` | send | optional | `openrouter.extractions` |
| `decide` | send | optional | `openrouter.decisions` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|

### Actions

None.

### Bus events

`rpc.inference.account`
<!-- /generated:capabilities -->

## Errors

Every failure reads `CODE: What happened. Next step: What to do.`

<!-- generated:errors -->
| Code | Meaning |
|---|---|
| `NEEDS_SIGN_IN` | the account is not signed in |
| `SCOPE_MISSING` | the call needs a scope the person has not confirmed |
| `ACCOUNT_REQUIRED` | the plugin serves several accounts and the call names none |
| `ACCOUNT_UNKNOWN` | the call names an alias the plugin does not serve |
| `ACCOUNT_MISMATCH` | the item belongs to another account |
| `CURSOR_INVALID` | the cursor is malformed, or belongs to another source, account or scope |
| `CURSOR_EXPIRED` | the provider no longer keeps the history the cursor names |
| `RATE_LIMITED` | the provider asked the plugin to slow down |
| `BUDGET_EXCEEDED` | the read would cost more than the person allows |
| `SOURCE_DISABLED` | the person turned this source or action off |
| `TOO_LARGE` | the answer is larger than the source's maxBytes |
| `INPUT_INVALID` | the input does not match the method's schema |
| `SOURCE_UNKNOWN` | the plugin declares no such source |
| `SCHEMA_VIOLATION` | an answer does not keep the contract's shape |
| `PERMISSION_DENIED` | the person's grant does not cover the call |
| `PLAN_INVALID` | the plan is missing, or belongs to another method |
| `PLAN_USED` | the plan was already used by an earlier commit |
| `GRANT_INVALID` | the action grant did not verify, or was already spent |
| `HOST_UNTESTED` | OpenCode is outside the plugin's tested range |
| `OPTIONS_INVALID` | the plugin's options do not match their schema |
| `UNAVAILABLE` | the provider could not be reached |
<!-- /generated:errors -->

## Known limits

- Enabled in v0.0.0: OpenRouter's alpha Extractions and Decisions routes as the fixture records them (see
  `tools.inference.capabilities`). A route the fixture disables, such as an image or PDF route, refuses before reading.
- No result cache and no automatic retry. A paid call that timed out or was cancelled after sending may have been
  charged; its result keeps the operation and the reservation, and a second send is a second charge.
- No spend cap is set by default. `spend.requestUsd`, `spend.sessionUsd` and `spend.rolling24hUsd` are opt-in, and each
  result reports its own cost. `status` has no cost total (the contract's status shape has no cost field).
- `probe` proves the integration is signed in; it does not verify whose OpenRouter account the key belongs to
  (`owner.verified` is `false`).

## Docs

- [Capabilities](docs/capabilities.md)
- [Accounts](docs/accounts.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Automations](docs/automations.md)
- [Security](docs/security.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the code bundled into `dist/`.
