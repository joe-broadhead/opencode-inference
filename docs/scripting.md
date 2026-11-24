# Scripting

Unofficial plugin. Not affiliated with OpenCode or OpenRouter.

A script calls Inference's tools with no model through the tools RPC, `inference.core.tools`:

```sh
opencode api post /api/rpc/inference.core.tools/<method> -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<session>","input":{…}}}'
```

The outer `input` is the HTTP body's; the inner `{ sessionID, input }` is the method's envelope, and its `input` is the
tool's own input. `describe` lists the methods, their classes and permission actions, whether each can run now, and each
tool's input and output as JSON Schema; it is the authoritative shape.

<!-- generated:tools -->

| Tool | Host tool and permission | Code Mode | Tools RPC method | Class | Network | Uploads source | Billable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `inference.status` | `inference_status` | `tools.inference.status(input)` | `inference.core.tools/status` | read | no | no | no |
| `inference.capabilities` | `inference_capabilities` | `tools.inference.capabilities(input)` | `inference.core.tools/capabilities` | read | no | no | no |
| `inference.plan` | `inference_plan` | `tools.inference.plan(input)` | `inference.core.tools/plan` | read | no | no | no |
| `inference.extract` | `inference_extract` | `tools.inference.extract(input)` | `inference.core.tools/extract` | send | yes | yes | yes |
| `inference.decide` | `inference_decide` | `tools.inference.decide(input)` | `inference.core.tools/decide` | send | yes | yes | yes |

<!-- /generated:tools -->

In Code Mode the same tool is `await tools.inference.<name>(input)`.

## A script runs as a session

Every call names a session, and the session must name an agent. The call resolves the method's action,
`inference_<name>` on `*`, against the agent's rules and then the session's: only an `allow` runs. An `ask` is refused,
because no one can answer it, and so is a `deny`, with no tool call. A saved "Always allow" does not authorize an ad-hoc
script.

Each method runs the same dispatcher as the model's tool: the same strict input, the same availability check at the
moment of the call, and the same output. A result is the tool's own output as plain JSON.

## Examples

Plan an extraction first: it is local and spends nothing. The method's input:

<!-- example: plan -->
```json
{
  "task": "extract",
  "input": {
    "source": { "kind": "text", "text": "Invoice AB-72. Total EUR 120.00." },
    "profile": "extract-typed",
    "fields": { "invoice_id": { "type": "text" }, "total": { "type": "number", "decimals": 2 } }
  }
}
```

sent as:

```sh
opencode api post /api/rpc/inference.core.tools/plan -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<session>","input":<the input above>}}'
```

<!-- outcome: plan -->
The plan selects `cloudflare/clairic`, which is eligible: its compatibility canary passed and its price is known. The
quote is an estimate, because a per-token price is never a ceiling, so the call itself reserves the whole per-request
budget. Nothing is read, sent or charged by the plan.

The same input without `task` is what `extract` takes:

<!-- example: extract -->
```json
{
  "source": { "kind": "text", "text": "Invoice AB-72. Total EUR 120.00." },
  "profile": "extract-typed",
  "fields": { "invoice_id": { "type": "text" }, "total": { "type": "number", "decimals": 2 } }
}
```

and a decision takes questions, or a versioned `questionSet` from the trusted options:

<!-- example: decide -->
```json
{
  "source": { "kind": "text", "text": "Payment received for invoice AB-72." },
  "profile": "decide-text",
  "questions": { "paid": { "type": "noul", "prompt": "Has the invoice been paid?" } }
}
```

On a disabled route either is refused with `CAPABILITY_UNSUPPORTED` before anything is read or sent;
`inference_capabilities` lists the enabled routes.

## Scheduled reads

A scheduled read is an OpenCode automation whose code action calls `tools.inference.<method>`, with a cadence as slow
as the work allows. A send tool (`extract`, `decide`) in an automation spends money with no one present, and an `ask`
cannot be answered there: schedule reads and plans, and keep sends in a session whose agent allows them under its own
rules.

## Errors

A refusal is the RPC error `failed`, with `data: { code, next }`. The codes are in
[configuration.md](configuration.md#errors).
