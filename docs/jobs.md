# Jobs recipe: an invoice's due date

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

A no-model script for [Jobs](https://github.com/joe-broadhead/opencode-jobs) that extracts an invoice's issue date and
payment terms with `inference.core.extract`, then computes the due date with Utilities' `time_add`, so the arithmetic is
deterministic and separately attributable. It returns a reviewable draft, never a write: send the draft on with the
destination's own permitted tool.

**Every Inference route is disabled until its compatibility canary has passed**, so in this version the extract call
is refused with `CAPABILITY_UNSUPPORTED` and the script fails before sending anything. The recipe is ready for the day a
route is enabled; `test/host/jobs.test.ts` runs this exact script and manifest through Jobs on a real OpenCode host,
against a loopback fake OpenRouter, so it cannot drift from the real bindings.

## The manifest and the script

A manifest entry is `<plugin id>.<method>`; the accessor nests by its dots. `inference.core.extract` is
`tools.inference.core.extract` (the tools RPC `inference.core.tools`, method `extract`), and `utilities.local.time_add`
is `tools.utilities.local.time_add`.

<!-- recipe: uses -->
```json
["inference.core.extract", "utilities.local.time_add"]
```

<!-- recipe: code -->
```js
const extracted = await tools.inference.core.extract({
  source: { kind: "text", text: "Invoice AB-72. Issued 2026-11-01. Terms: net 30 days." },
  profile: "extract-typed",
  fields: {
    issued_on: { type: "date", required: true },
    net_days: { type: "number", integer: true, required: true },
  },
})
const fields = extracted.data.fields
const missing = Object.keys(fields).filter((key) => fields[key].value === null)
if (missing.length > 0) {
  // An absent value stays absent: no due date is guessed. The person reviewing gets the reasons and the operation.
  return { draft: null, missing, review: extracted.review, operationId: extracted.operationId }
}
const due = await tools.utilities.local.time_add({ date: fields.issued_on.value, operation: "add", amount: fields.net_days.value, unit: "days" })
return {
  draft: { issuedOn: fields.issued_on.value, netDays: fields.net_days.value, dueOn: due.result },
  review: extracted.review,
  operationId: extracted.operationId,
  usage: extracted.usage,
}
```

## Running it

Once, now: the `jobs_run_script` tool with `{ code, uses, agent }` (the code and manifest above, and an agent whose
rules allow `inference_extract` and `utilities_time_add`). On a schedule: a Jobs `script` action with the same `code`
and `uses`. Jobs resolves every manifest entry through each plugin's tools RPC `describe`, approves the script's digest
under its own access rules, and runs it in a session whose agent allows exactly the manifest's actions.

- **Review stays attached.** `review` and `operationId` travel with the draft: under `review-first-v1` every extraction
  is reviewed, so a person or a later step checks the draft before anything uses it.
- **Absent stays absent.** A null field ends the script with the missing keys; nothing is guessed.
- **Spend.** Each run sends the text to OpenRouter and reserves budget first, under the plugin's spend options. Pass
  identifiers and compact results between steps, not file contents.
- **No blind retry.** A `SUBMISSION_UNKNOWN` or deadline failure means the call may have been charged: the next
  scheduled run is a new operation, so do not schedule tighter than the work needs.
