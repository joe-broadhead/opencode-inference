// Exact arithmetic on plain decimal strings (no exponent), for probabilities: a provider's 0.7 stays "0.7", and sums,
// differences and comparisons are exact. Values are scaled to 10^-64; a literal with more than 64 fractional digits is
// refused where it is read, never rounded here.

const PLACES = 64
const SCALE = 10n ** BigInt(PLACES)
const PLAIN = /^(?:0|[1-9]\d*)(?:\.\d{1,64})?$/

/** True for a plain non-negative decimal with at most 64 fractional digits. */
export const isPlain = (text: string) => PLAIN.test(text)

/** A plain decimal as an integer count of 10^-64. Throws on anything else. */
export function units(text: string): bigint {
  if (!PLAIN.test(text)) throw new RangeError("not a plain decimal")
  const [whole, fraction = ""] = text.split(".")
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(PLACES, "0"))
}

/** An integer count of 10^-64 as a plain decimal, without trailing zeros. */
export function decimal(value: bigint): string {
  const sign = value < 0n ? "-" : ""
  const magnitude = value < 0n ? -value : value
  const fraction = (magnitude % SCALE).toString().padStart(PLACES, "0").replace(/0+$/, "")
  return `${sign}${magnitude / SCALE}${fraction ? `.${fraction}` : ""}`
}

/** A finite non-negative JS number (a configured threshold) as its shortest exact decimal, e.g. 0.9 -> "0.9". */
export function ofNumber(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("not a finite non-negative number")
  const text = String(value)
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(text)
  if (!match) throw new RangeError("not a decimal number")
  const digits = `${match[1]}${match[2] ?? ""}`
  const exponent = Number(match[3] ?? "0") - (match[2]?.length ?? 0)
  return exponent >= 0 ? BigInt(digits) * 10n ** BigInt(exponent) * SCALE : (BigInt(digits) * SCALE) / 10n ** BigInt(-exponent)
}

export const ONE = SCALE
