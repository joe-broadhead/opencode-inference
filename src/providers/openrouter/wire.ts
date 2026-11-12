import { InferenceError } from "../../domain/errors.js"
import { isPlain, ONE, units } from "../../domain/decimal.js"
import { decimalOf, JsonNumber, type Json } from "../../domain/json.js"
import { format, money, roundUp } from "../../domain/money.js"
import type { Adapter, AdapterResult } from "../../runtime/operation.js"
import type { RouteCapability } from "./capabilities.js"

// What every OpenRouter alpha adapter reads the same way: JSON values from the exact reader (json.ts), the usage block
// and the price. Each adapter passes its own `fail`, so a contract failure names its endpoint and wire revision.

export type Fail = (what: string) => InferenceError
export type JsonObject = { [key: string]: Json }

export const isObject = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber)
/** An object's own entries as a Map: keys are looked up without reaching a prototype. */
export const entries = (object: JsonObject) => new Map(Object.entries(object))
export const REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/

/** A probability in 0..1 exactly as reported, or undefined when absent. Never invented, never clamped. */
export function probabilityOf(value: Json | undefined, what: string, fail: Fail) {
  if (value === undefined || value === null) return undefined
  if (!(value instanceof JsonNumber) || !Number.isFinite(value.value) || value.value < 0 || value.value > 1) throw fail(`${what} is not a probability`)
  return value.value
}

/**
 * A probability in 0..1 exactly as reported, as a plain decimal string ("1.5e-7" becomes "0.00000015"), or undefined
 * when absent. Never converted to a binary float, clamped or rounded; more than 64 fractional digits is refused.
 */
export function exactProbabilityOf(value: Json | undefined, what: string, fail: Fail) {
  if (value === undefined || value === null) return undefined
  const text = value instanceof JsonNumber ? decimalOf(value) : undefined
  if (text === undefined || !isPlain(text) || units(text) > ONE) throw fail(`${what} is not a probability`)
  return text
}

export function countOf(value: Json | undefined, what: string, fail: Fail) {
  if (value === undefined || value === null) return undefined
  if (!(value instanceof JsonNumber) || !/^(?:0|[1-9]\d{0,15})$/.test(value.text) || !Number.isSafeInteger(value.value)) throw fail(`${what} is not a count`)
  return value.value
}

/** An exact, non-negative USD amount from a JSON number, rounded up to the 12 places money keeps. */
export function amountOf(value: Json | undefined, what: string, fail: Fail) {
  if (value === undefined || value === null) return undefined
  const decimal = value instanceof JsonNumber ? decimalOf(value) : undefined
  if (decimal === undefined || !/^\d{1,12}(?:\.\d+)?$/.test(decimal)) throw fail(`${what} is not a non-negative amount`)
  return format(roundUp(decimal, 12))
}

/**
 * The usage block. usage.cost is OpenRouter's whole charge; its upstream component is a breakdown, never added to it.
 * Only under BYOK is the upstream amount billed separately, by the upstream provider, and recorded as its own charge.
 */
export function usageOf(raw: Json | undefined, fail: Fail): AdapterResult["usage"] {
  if (raw === undefined || raw === null) return { charges: [], costStatus: "unknown" }
  if (!isObject(raw)) throw fail("usage is not an object")
  const usage = entries(raw)
  const cost = amountOf(usage.get("cost"), "usage.cost", fail)
  const inputTokens = countOf(usage.get("prompt_tokens"), "usage.prompt_tokens", fail)
  const outputTokens = countOf(usage.get("completion_tokens"), "usage.completion_tokens", fail)
  const byok = usage.get("is_byok")
  if (byok !== undefined && byok !== null && typeof byok !== "boolean") throw fail("usage.is_byok is not a boolean")
  const details = usage.get("cost_details")
  if (details !== undefined && details !== null && !isObject(details)) throw fail("usage.cost_details is not an object")
  const upstream = isObject(details) ? amountOf(entries(details).get("upstream_inference_cost"), "usage.cost_details.upstream_inference_cost", fail) : undefined
  const charges: AdapterResult["usage"]["charges"] = [
    ...(cost !== undefined ? [{ party: "platform" as const, currency: "USD", amount: cost, basis: "reported" as const }] : []),
    ...(byok === true && upstream !== undefined ? [{ party: "upstream" as const, currency: "USD", amount: upstream, basis: "reported" as const }] : []),
  ]
  return {
    charges,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    // Under BYOK without a reported upstream amount, part of the cost is unknown.
    costStatus: cost === undefined || (byok === true && upstream === undefined) ? "unknown" : "known",
  }
}

/**
 * The price before sending. A per-request price alone, marked as the whole charge, is an exact upper bound. A per-token
 * price is never bounded locally: a provider's server-side prompt template can add tokens the request body does not
 * contain, so it is an upper bound only through a ceiling the provider documents (`pricing.ceiling`, with its source);
 * otherwise it is an estimate, and the call reserves the whole per-request budget. The estimate itself (per-request
 * price plus the input price for the body's UTF-8 bytes) is exact and rounded UP to 12 places.
 */
export function quoteOf(route: RouteCapability, bodyBytes: () => number): ReturnType<Adapter["quote"]> {
  const pricing = route.pricing
  if (!pricing) return { kind: "unavailable" }
  const perToken = pricing.perMillionInputTokens !== undefined || pricing.perMillionOutputTokens !== undefined
  if (perToken && pricing.ceiling !== undefined) return { kind: "upper_bound", amount: format(money(pricing.ceiling.amount)) }
  let units = pricing.perRequest === undefined ? 0n : money(pricing.perRequest).units
  if (pricing.perMillionInputTokens !== undefined) {
    // units are 10^-12 USD; per million tokens means a further 10^-6: the exact product has 18 places.
    const exact = money(pricing.perMillionInputTokens).units * BigInt(bodyBytes())
    const text = exact.toString().padStart(19, "0")
    units += roundUp(`${text.slice(0, -18)}.${text.slice(-18)}`, 12).units
  }
  return { kind: !perToken && pricing.upperBound ? "upper_bound" : "estimate", amount: format({ currency: "USD", units }) }
}
