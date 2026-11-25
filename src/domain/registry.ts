import type { MethodClass } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { OperationInfo } from "./capabilities.js"
import type { Operation } from "./contracts.js"
import type { Module } from "./ids.js"

// The operations this version knows about, and whether each one has a method. `extract` and `decide` are registered
// through the contract's `register`; `read` stays planned: capabilities and plan describe it, and nothing registers it.

export const OPERATION_MODULE: { readonly [O in Operation]: Module } = { extract: "extractions", decide: "decisions", read: "understanding" }

/** Every operation, registered or not, for capabilities and plan. `tool` is the contract's permission action. */
export const OPERATION_INFO: readonly OperationInfo[] = [
  { name: "extract", tool: "inference.extract", class: "send", module: "extractions" },
  { name: "decide", tool: "inference.decide", class: "send", module: "decisions" },
  { name: "read", tool: "inference.read", class: "send", module: "understanding" },
]

const IMPLEMENTED = new Set<Operation>(["extract", "decide"])

/** Whether an operation's method is declared in this version: extract and decide are; read is not yet. */
export const implemented = (operation: Operation) => IMPLEMENTED.has(operation)

/** Reserved for later releases: described by capabilities and plan, never declared as a method. */
export const PLANNED: readonly OperationInfo[] = OPERATION_INFO.filter((operation) => !implemented(operation.name))

/** The method class contract §6 defines, for a capability's operation. */
export type { MethodClass }
