# Security

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## What this version does

- `inference_status`, `inference_capabilities` and `inference_plan` are local: they read the plugin options, a committed
  capability fixture and the host's own state.
- `inference_extract` and `inference_decide` send the source to OpenRouter and can be charged, but only on an enabled
  route, and every route is disabled in this version: it refuses before reading a file, resolving the key or sending anything. A route is
  enabled only in a reviewed change after the opt-in canary has passed.
- The OpenRouter transport (`src/providers/openrouter/http.ts`) is the only code that reaches the network or resolves
  the key: one trusted origin, two reviewed paths, the key in one `Authorization` header, no redirects followed, a
  deadline, byte caps and cancellation. `npm run lint` checks that boundary on the syntax tree.
- Before reading a file the host is asked (`read`, and `external_directory` outside the project, by the real folder).
  No byte is read before that answer; symbolic links inside the project, `..` and a file replaced or changed after
  approval are refused, and the type comes from the bytes.
- The operation journal is private (a 0700 folder, a 0600 file) and holds hashes, ids, the route, timing, amounts and
  error codes: never a key, source text, a request or response body, or a URL.
- A decision's accepted label is information, never a permission: no label, probability or acceptance grants a file
  read, a send, a budget or any other action.
- No key is an option. The canary scripts read a key only from `OPENROUTER_CANARY_KEY`, refuse in CI and without a
  budget, a per-call worst case and an explicit acknowledgement, and are never run by the checks.
- Errors follow `CODE: what happened. Next step: …` and carry no key, source text or field value.

Content a caller supplies, and anything a provider returns in a later release, is untrusted data, never instructions.
