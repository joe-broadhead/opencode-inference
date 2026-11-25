# Changelog

## 0.0.0 (2026-11-25)

The first release: `inference` on plugin-contract v0.0.0, with no earlier release to carry over.

- **Capability manifest.** `status`, `probe`, `capabilities`, `plan`, `extract` and `decide`; one `account` bus event;
  no sources, actions or pass-through MCP tools. The package has no runtime dependencies, and `dist/` is committed so
  a release tag installs with no build.
- **Accounts.** One OpenCode integration per alias (`inference` for the default, `inference-<alias>` otherwise), each
  with its own OpenRouter key, journal and permission resources. `extract`, `decide` and `probe` take `account`; the
  default is one account.
- **Access.** The contract's `access` module generates every agent's rules from each method's class: the four reads
  always run, and `extract` and `decide` follow `all`, `ask-changes` or `read-only`.
- **Doors and bus.** One `contract.register` call wires the agent tool, Code Mode and RPC for every method. Handlers
  live in `src/handlers/`, the provider in `src/provider/`, and `probe` emits the `account` nudge through `call.bus`.
- **Status and probe.** One `statusAnswer`/`STATUS_SCHEMA` answer is shared by the tool, RPC, TUI and `/inference`;
  `probe` proves an alias's sign-in without reading the key and reports an unverified owner.
- **Planning and sends.** `plan` is a local quote and review without a plan id; `extract` and `decide` are plain sends
  with their full input. Each result keeps its cost in `usage`, and `plan` quotes the route before a send.
- **Provider.** One trusted origin and the reviewed alpha Extractions and Decisions paths, a key per alias resolved only
  at the transport boundary, no redirects, a deadline, byte caps and cancellation. A route runs only while its
  compatibility canary matches the adapter's wire revision.
- **Spend and journal.** The operation-keyed reservation and the private journal are kept per account, and a call whose
  cost is unknown keeps its reservation instead of being treated as free.
- **Documentation and tests.** README, AGENTS.md, the five docs, CONTRIBUTING, SECURITY, both skills and the generated
  sections are written for this release. Unit, conformance, host and pack suites cover the contract doors, two
  synthetic accounts and the built package; `npx plugin-kit check` is the gate.
