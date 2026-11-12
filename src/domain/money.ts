// Exact money. An amount is a non-negative decimal string with at most 12 fractional digits (the `Decimal` contract),
// held as an integer count of 10^-12 units, so sums and comparisons never touch binary floating point. Twelve places
// keep every native unit the handoff names exactly: micro-dollars, and xAI's ticks (10^10 per dollar).
//
// An amount carries its denomination. Only equal denominations are added or compared: credits are never summed with
// USD, and a conversion needs a documented rate, which this module does not have.

import { InferenceError } from "./errors.js"

const PLACES = 12
const SCALE = 10n ** BigInt(PLACES)
const DECIMAL = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/

/** An exact amount in one denomination, in units of 10^-12. */
export interface Money {
  readonly currency: string
  readonly units: bigint
}

const notExact = () =>
  new InferenceError("PROVIDER_CONTRACT_CHANGED", "An amount is not an exact non-negative decimal with at most 12 fractional digits.", "Round a finer provider price up with roundUp before it becomes a quote or a charge, and update the adapter.")

/** Parses a decimal string. Throws a coded error on anything but a plain non-negative decimal with at most 12 places. */
export function money(amount: string, currency = "USD"): Money {
  if (!DECIMAL.test(amount)) throw notExact()
  const [whole, fraction = ""] = amount.split(".")
  return { currency, units: BigInt(whole!) * SCALE + BigInt(fraction.padEnd(PLACES, "0")) }
}

/**
 * Rounds a non-negative decimal of any precision UP to `places` fractional digits (0 to 12): the conservative direction
 * for an upper bound or a reservation. "0.0000000000001" becomes "0.000000000001", never "0".
 */
export function roundUp(amount: string, places = PLACES, currency = "USD"): Money {
  if (!Number.isInteger(places) || places < 0 || places > PLACES) throw new RangeError("places must be an integer from 0 to 12")
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d+)?$/.test(amount)) throw notExact()
  const [whole, fraction = ""] = amount.split(".")
  const kept = fraction.slice(0, places)
  const dropped = /[1-9]/.test(fraction.slice(places))
  const units = (BigInt(whole!) * 10n ** BigInt(places) + BigInt(kept.padEnd(places, "0") || "0") + (dropped ? 1n : 0n)) * 10n ** BigInt(PLACES - places)
  return { currency, units }
}

export const zero = (currency = "USD"): Money => ({ currency, units: 0n })

/** The canonical decimal string: no trailing zeros, no trailing point. */
export function format(value: Money): string {
  const whole = value.units / SCALE
  const fraction = (value.units % SCALE).toString().padStart(PLACES, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

const same = (a: Money, b: Money) => {
  if (a.currency !== b.currency) throw new RangeError(`cannot combine ${a.currency} with ${b.currency}`)
}

export function add(a: Money, b: Money): Money {
  same(a, b)
  return { currency: a.currency, units: a.units + b.units }
}

/** a - b, never below zero. */
export function subtract(a: Money, b: Money): Money {
  same(a, b)
  return { currency: a.currency, units: a.units > b.units ? a.units - b.units : 0n }
}

/** -1, 0 or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b)
  return a.units < b.units ? -1 : a.units > b.units ? 1 : 0
}

export const min = (a: Money, b: Money) => (compare(a, b) <= 0 ? a : b)
export const max = (a: Money, b: Money) => (compare(a, b) >= 0 ? a : b)
export const sum = (values: readonly Money[], currency = "USD") => values.reduce(add, zero(currency))
