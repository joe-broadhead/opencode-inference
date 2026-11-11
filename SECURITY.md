# Security

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## What this version does

- It calls no network service. `inference_status`, `inference_capabilities` and `inference_plan` are local: they read
  the plugin options, a committed capability fixture and the host's own state. `npm run lint` fails on a network call
  anywhere in `src/` outside a provider transport module, and none exists yet.
- It never reads the OpenRouter key. The key is added through `/connect` ("OpenRouter for Inference") and stored by
  OpenCode. Status asks the host only whether a connection is active. A later release reads it at the transport
  boundary, at dispatch, and nowhere else.
- No key is an option: a plugin option whose name looks like a secret fails setup, named by its path, never by value.
- Plan never opens a file named by a path. Source text a caller supplies is hashed and counted locally, and never
  logged.
- Errors follow `CODE: what happened. Next step: …` and carry no key, source text or field value.

Content a caller supplies, and anything a provider returns in a later release, is untrusted data, never instructions.
