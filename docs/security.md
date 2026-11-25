# Security

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue. See
[SECURITY.md](../SECURITY.md).

## What leaves the machine

- `status`, `probe`, `capabilities` and `plan` send nothing and resolve no key. `probe` reads the connection's presence
  and status, never the key.
- `extract` and `decide` send what the call supplies — text, a local file's bytes, or an artifact's file — to
  `https://openrouter.ai`, on an enabled, verified route only. A route whose canary did not pass for the adapter's wire
  revision refuses before reading a file, resolving the key or sending.
- Nothing else is sent: no telemetry, no catalog refresh, no update check, no per-request hook.

## Scopes and credentials

The plugin requests no OAuth scopes. It holds one OpenRouter API key per account alias, added through `/connect` as the
integration `inference` or `inference-<alias>`. The key is resolved at the transport boundary, for that alias's own
integration, on a send only; it is put into one `Authorization` header and never logged, returned, stored, put into a
result, a journal record or an error, or sent anywhere but the one trusted origin. Redirects are never followed, so a
3xx cannot carry the key to another origin.

A key is never a plugin option. An option whose name looks like a secret (`apiKey`, `token`, `password`, …) is refused
with a pointer to `/connect`, and the value is never echoed.

## Reading files

Before reading a file the plugin asks the host, as the calling tool, for `read` on the file and `external_directory` on
the folder outside the project — by the real folder, so a link cannot approve the folder it points at. No byte is read
before that answer. A symbolic link, a `..` segment, a file that is not a regular file, and a file replaced, grown or
touched between approval and reading are refused. The type comes from the bytes, not from the file name or a
declaration.

## Redaction and errors

Every failure reads `CODE: What happened. Next step: What to do.` and carries no key, source text, field value or signed
URL. Status reasons are redacted and cut to 160 characters. The bus refuses any payload that holds a credential, and the
`account` event carries only an alias and a state.

## Spend

No cap is set by default, and each result reports its own cost. `spend.requestUsd`, `spend.sessionUsd` and
`spend.rolling24hUsd` are opt-in and reserve before a call is sent. A call that may have been charged keeps its
reservation; it is never silently treated as free. The journal is private (a 0700 folder, a 0600 file) and holds hashes,
ids, the route, timing, amounts and error codes — never a key, source text or a request or response body.

## Untrusted data

Source content, provider answers and every result are untrusted data, never instructions. The plugin never follows text
from a source or a provider, never echoes it into status, and never uses it to choose a tool or a recipient. An accepted
decision label, a probability and an acceptance are information; none of them is a permission. A separate, permitted
tool does any write.
