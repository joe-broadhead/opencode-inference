// Exact money. An amount is a non-negative decimal string with at most 12 fractional digits (the `Decimal` contract),
// held as an integer count of 10^-12 units, so sums and comparisons never touch binary floating point. Twelve places
// keep every native unit the handoff names exactly: micro-dollars, and xAI's ticks (10^10 per dollar).
//
// An amount carries its denomination. Only equal denominations are added or compared: credits are never summed with
// USD, and a conversion needs a documented rate, which this module does not have.

const PLACES = 12
const SCALE = 10n ** BigInt(PLACES)
const DECIMAL = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/

/** An exact amount in one denomination, in units of 10^-12. */
export interface Money {
  readonly currency: string
  readonly units: bigint
}

/** Parses a decimal string. Throws on anything that is not a plain non-negative decimal with at most 12 places. */
export function money(amount: string, currency = "USD"): Money {
  if (!DECIMAL.test(amount)) throw new RangeError("not an exact decimal amount")
  const [whole, fraction = ""] = amount.split(".")
  return { currency, units: BigInt(whole!) * SCALE + BigInt(fraction.padEnd(PLACES, "0")) }
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
