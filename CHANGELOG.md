# Changelog

## 0.0.0

The first release on plugin-contract v0: the plugin is rebuilt from `master` on the contract, with no compatibility with
the old repository.

- **Manifest.** One `capabilities` key: `inference`, `status`, `probe`, `capabilities`, `plan`, `extract` and `decide`;
  accounts through OpenCode integrations; no `sources`, no actions, and one bus event, `account`. No app key, `sources` or `opencode` key, and no runtime dependency.
- **Doors.** One `contract.register` call wires the agent tool, Code Mode and RPC for every method. Handlers live in
  `src/handlers/`, the provider client in `src/provider/`; the old tools RPC and its `describe` are gone.
- **Accounts.** One OpenCode integration per alias (`inference` for the default, `inference-<alias>` otherwise), each
  with its own key auth method, its own journal and its own permission resources. `extract`, `decide` and `probe` take
  `account`; by default there is one `default` account.
- **Access.** The contract's `access` module generates the rules from each method's class: the four reads always run,
  `extract` and `decide` follow `all`, `ask-changes` or `read-only`.
- **Status and probe.** Status is one contract answer shared by the tool, RPC and `/inference`: the host range, every
  alias, the agents without the generated rules and one next step. `probe` proves an alias is signed in, emits the
  `account` nudge, and reports an unverified owner: OpenCode knows the integration, not whose key it is.
- **Planning.** `plan` stays a local quote read without a plan id; `extract` and `decide` are plain sends with their full
  input. Each result keeps its cost in `usage`; `status` has no cost total.
- **Provider.** One trusted origin and the reviewed alpha Extractions and Decisions paths, a key per alias, no redirects,
  a deadline, byte caps and cancellation. A route runs only while its canary matches the adapter's wire revision.
- **Spend and journal.** The operation-keyed reservation and the private journal are unchanged for the new alias model:
  each alias's journal is keyed on its own connection, and a call whose cost is unknown keeps its reservation.
- **Kit.** The copied release, drift, copy, icon, forbidden, tested-host, capture and changelog scripts are replaced by
  `plugin-kit`. The two route canaries, the evaluation script and the transport-boundary check stay.
- **Docs and skills.** README, AGENTS.md, the five docs, CONTRIBUTING.md, SECURITY.md and both skills are written fresh
  for this release; generated sections come from `plugin-kit docs`.
- **Tests.** Unit tests cover the pure rules and the operation pipeline; the conformance suite records two synthetic
  accounts, the status answer and the account nudge; the host suite runs the built plugin on OpenCode 2.4.1; the pack
  suite installs the tarball and starts it. `npx plugin-kit check` is the gate.
