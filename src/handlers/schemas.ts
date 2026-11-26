import * as z from "zod"
import type { JsonSchema } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { CapabilitiesResult } from "../domain/capabilities.js"
import { CapabilitiesInput, DecideInput, DecideResult, ExtractInput, ExtractResult, OPERATIONS, PlanResult } from "../domain/contracts.js"

// The JSON Schemas the register checks inputs and answers against. They come from the plugin's own zod contracts, so a
// contract and the door that validates it cannot drift.

/** One zod schema as plain JSON Schema, for the register and the agent tool. */
export const schemaOf = (schema: z.ZodType, io: "input" | "output"): JsonSchema => z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema

/** A method that takes no input. */
export const EMPTY_INPUT: JsonSchema = { type: "object", properties: {}, additionalProperties: false }

/** The plan method's input: a task and the input it would run with. The handler checks the pairing against PlanInput. */
export const PLAN_INPUT: JsonSchema = schemaOf(z.strictObject({ task: z.enum(OPERATIONS), input: z.unknown() }), "input")

export const CAPABILITIES_INPUT: JsonSchema = schemaOf(CapabilitiesInput, "input")
export const CAPABILITIES_OUTPUT: JsonSchema = schemaOf(CapabilitiesResult, "output")
export const PLAN_OUTPUT_SCHEMA: JsonSchema = schemaOf(PlanResult, "output")
export const EXTRACT_INPUT: JsonSchema = schemaOf(ExtractInput, "input")
export const EXTRACT_OUTPUT: JsonSchema = schemaOf(ExtractResult, "output")
export const DECIDE_INPUT: JsonSchema = schemaOf(DecideInput, "input")
export const DECIDE_OUTPUT: JsonSchema = schemaOf(DecideResult, "output")
