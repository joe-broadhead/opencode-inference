# Security

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

## Report a vulnerability

Report it privately through GitHub's security advisories for this repository
(<https://github.com/we-the-rebel-alliance/inference-plugin/security/advisories/new>), not in a public issue. Include the
version (`package.json`), the OpenCode release, what an attacker can do and the smallest reproduction you have. Do not
include a real API key, source text or personal data: rotate any key you believe was exposed.

We aim to answer within seven days. We will credit you in the advisory unless you ask us not to.

## Scope

- The plugin's code in `src/`, the built `dist/`, the manifest in `package.json`, the skills and the docs.
- Out of scope: OpenCode itself, OpenRouter's API, and the coding model's own provider credentials (the plugin never
  reads them).

## What the plugin handles

- **Credentials:** one OpenRouter API key per account alias, held by OpenCode's integration (`inference` or
  `inference-<alias>`). The key is read only at the transport boundary for a send on an enabled route, sent only to
  `https://openrouter.ai`, and never logged, returned or stored.
- **Content:** what a call supplies — text, a file's bytes or an artifact — goes to OpenRouter on a send. The four reads
  send nothing. Every result is untrusted data.
- **Local files:** read only after the host approves `read` (and `external_directory` outside the project, by the real
  folder), through a descriptor, verified against the file that was approved.
- **Spend:** opt-in caps reserve before a call is sent; a call whose cost is unknown keeps its reservation. The journal
  holds hashes, ids, the route, timing, amounts and error codes, never a key or content.

See [docs/security.md](docs/security.md) for the mechanism.
