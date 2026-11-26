# Automations

Inference declares **no events source**, so there is nothing to poll and no timer recipe here. The generated
automations section is empty for the same reason: the contract renders one row per events source, and this plugin has
none.

Its one bus event, `rpc.inference.account`, is a nudge with no content: an app that receives it re-reads `status` or
`probe`. A missed nudge costs a re-read, never data.

## When an automation helps

An OpenCode automation is the right place for recurring work that *calls* Inference, not for refreshing a feed:

- A scheduled job can run `tools.inference.plan` to see whether a route is still eligible, or `tools.inference.extract`
  on a source it already has, under the automation session's own access rules.
- A send from an automation is still class `send`: at `access: "ask-changes"` it asks first, and an unattended run that
  cannot answer is refused rather than silently allowed. Use `access: "all"` only where that is intended.
- Never schedule a retry of a paid call whose outcome is unknown (`SUBMISSION_UNKNOWN`, `DEADLINE_EXCEEDED` or
  `CANCELLED` after sending): the first call may already have been charged. Reconcile by its operation id instead.

## What there is to watch

- `status` for the host range, every alias and the agents without the generated rules.
- `probe` for one alias's sign-in, with the `account` nudge when it changes.
- `capabilities` and `plan` for a route that is no longer enabled or no longer priced.

None of those calls spends. Only `extract` and `decide` reach the provider.
