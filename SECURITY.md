# Security

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## What this version does

- It calls no network service. `inference_status`, `inference_capabilities` and `inference_plan` are local: they read
  the plugin options, a committed capability fixture and the host's own state. The OpenRouter transport
  (`src/providers/openrouter/http.ts`) exists, but no registered tool reaches it. `npm run lint` fails on any reference
  to `fetch`, a network module (bare or `node:`), a network global or `connection.resolve` anywhere in `src/` outside
  that file.
- It never reads the OpenRouter key in this version. The key is added through `/connect` ("OpenRouter for Inference")
  and stored by OpenCode. Status asks the host only whether a connection is active. The transport is the only code that
  resolves it, at dispatch: it puts it in one `Authorization` header to `https://openrouter.ai`, follows no redirect
  (so no other origin can receive it), and never logs, returns or stores it.
- Before a later tool reads a file it asks the host (`read`, and `external_directory` outside the project). It reads no
  byte before that answer, refuses symbolic links inside the project, `..` and a file replaced or changed after
  approval, and types the file by its bytes.
- The operation journal is private (a 0700 folder, a 0600 file) and holds hashes, ids, the route, timing, amounts and
  error codes: never a key, source text, a request or response body, or a URL.
- No key is an option: a plugin option whose name looks like a secret fails setup, named by its path, never by value.
- Plan never opens a file named by a path. Source text a caller supplies is hashed and counted locally, and never
  logged.
- Errors follow `CODE: what happened. Next step: …` and carry no key, source text or field value.

Content a caller supplies, and anything a provider returns in a later release, is untrusted data, never instructions.
