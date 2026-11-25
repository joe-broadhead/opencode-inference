# Accounts

Inference signs in through OpenCode with **one integration per account alias** (contract §5, `accounts.via:
"integration"`). The plugin holds the credentials: one OpenRouter API key per alias. Nothing about the provider is
configured in a profile, so a profile has no fields.

<!-- generated:accounts -->
Accounts are held by the **integration** mechanism: the plugin holds the credentials.

The profile has no fields.
<!-- /generated:accounts -->

## Sign in per alias

| Alias | Integration id | How to sign in |
|---|---|---|
| `default` (no `accounts` option) | `inference` | `/connect`, choose **Inference** |
| `work` | `inference-work` | `/connect`, choose **Inference (work)** |
| `personal` | `inference-personal` | `/connect`, choose **Inference (personal)** |

The same integration can also be signed in from a terminal with `opencode auth login inference-work`. A hyphen
separates the plugin's name from the alias, so an alias itself is lowercase letters and digits and has no hyphen.

The key is read at the transport boundary only, when `extract` or `decide` runs on an enabled route, and is sent only to
`https://openrouter.ai`. It is never a plugin option, never returned, logged or stored, and `status` reads only whether
the connection is present and usable.

## Pick an account in a call

Every method that uses the key takes an `account`:

```json
{ "account": "work", "model": "cloudflare/clairic", "source": { "kind": "text", "text": "…" }, "fields": { "total": { "type": "number" } } }
```

- With one account, omitting `account` is fine.
- With several, omitting it is `ACCOUNT_REQUIRED`; the next step lists the aliases.
- An alias the plugin does not serve is `ACCOUNT_UNKNOWN`.
- A method that takes no account (`status`, `capabilities`, `plan`) refuses an `account` field with `INPUT_INVALID`.

`extract` and `decide` are billed to the account's own key and keep their own journal, so a call on `work` and a call on
`personal` never mix reservations.

## Status and probe

`status` lists every alias in the options' order with `ready`, `needs_sign_in` or `error`, and answers `ready` only when
every alias is usable. `probe({ account })` reads that alias's connection and answers the integration that holds it:

```json
{ "source": "openrouter", "account": "work", "owner": { "id": "integration:inference-work", "label": "inference-work (OpenRouter API key)", "verified": false }, "trust": "untrusted" }
```

`verified` is `false` because OpenCode knows the integration is signed in, not whose OpenRouter account the key belongs
to. The probe reads no content and never the key. It emits the `account` nudge: `ready` when the alias is usable,
`needs_sign_in` when it is not.

## Many accounts at once

```json
{
  "access": "ask-changes",
  "accounts": {
    "work": {},
    "personal": {}
  }
}
```

`status` then shows both aliases, `extract` and `decide` need `account`, and each alias signs in and refreshes
independently. A saved approval for `work` never approves a call on `personal`: the contract's permission resource
starts with the alias.
