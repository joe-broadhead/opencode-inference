import { InferenceError } from "./errors.js"

// A strict JSON reader that keeps every number exactly as written. JSON.parse turns a number into a binary float, so
// "0.000012345678901" or 120.10 would lose their exact text; money and decimals must not. Numbers come back as
// `JsonNumber`, holding the literal; everything else is plain JSON. The reader refuses anything JSON does not allow,
// duplicate keys (which JSON.parse silently resolves) and documents nested deeper than MAX_DEPTH.

/** A JSON number, as the literal text the provider wrote. */
export class JsonNumber {
  constructor(readonly text: string) {}
  /** The number as a float, for values that are not money (a probability, an offset). */
  get value() {
    return Number(this.text)
  }
}

export type Json = null | boolean | string | JsonNumber | Json[] | { [key: string]: Json }

const MAX_DEPTH = 64
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y

const malformed = (what: string) => new InferenceError("PROVIDER_CONTRACT_CHANGED", `OpenRouter's answer is not valid JSON: ${what}.`)

/** Parses `text` strictly. Throws PROVIDER_CONTRACT_CHANGED on anything that is not one JSON document. */
export function parseJson(text: string): Json {
  let at = 0
  const space = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) at++
  }
  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) throw malformed("nested too deeply")
    space()
    const char = text[at]
    if (char === "{") {
      at++
      // A Map, then Object.fromEntries: every key, "__proto__" included, becomes an own property.
      const entries = new Map<string, Json>()
      space()
      if (text[at] === "}") return at++, {}
      for (;;) {
        space()
        const key = string()
        if (entries.has(key)) throw malformed("a duplicate key")
        space()
        if (text[at++] !== ":") throw malformed("a missing colon")
        entries.set(key, value(depth + 1))
        space()
        const next = text[at++]
        if (next === "}") return Object.fromEntries(entries)
        if (next !== ",") throw malformed("a missing comma")
      }
    }
    if (char === "[") {
      at++
      const array: Json[] = []
      space()
      if (text[at] === "]") return at++, array
      for (;;) {
        array.push(value(depth + 1))
        space()
        const next = text[at++]
        if (next === "]") return array
        if (next !== ",") throw malformed("a missing comma")
      }
    }
    if (char === '"') return string()
    if (text.startsWith("true", at)) return (at += 4), true
    if (text.startsWith("false", at)) return (at += 5), false
    if (text.startsWith("null", at)) return (at += 4), null
    NUMBER.lastIndex = at
    const number = NUMBER.exec(text)
    if (number) return (at += number[0].length), new JsonNumber(number[0])
    throw malformed("an unexpected character")
  }
  const string = (): string => {
    STRING.lastIndex = at
    const match = STRING.exec(text)
    if (!match) throw malformed("a malformed string")
    at += match[0].length
    return JSON.parse(match[0]) as string
  }
  const result = value(0)
  space()
  if (at !== text.length) throw malformed("trailing content")
  return result
}

/**
 * A JSON number's exact value as a plain decimal string (no exponent), or undefined for a negative number. "1.5e-7"
 * becomes "0.00000015", exactly. Combine with roundUp to fit the 12 places money keeps.
 */
export function decimalOf(number: JsonNumber): string | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(number.text)
  if (!match || match[1] === "-") return undefined
  const digits = `${match[2]}${match[3] ?? ""}`
  const exponent = Number(match[4] ?? "0") - (match[3]?.length ?? 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) return undefined
  const whole = exponent >= 0 ? digits + "0".repeat(exponent) : digits.length > -exponent ? digits.slice(0, exponent) : "0"
  const fraction = exponent >= 0 ? "" : digits.length > -exponent ? digits.slice(exponent) : digits.padStart(-exponent, "0")
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "")
  const trimmedFraction = fraction.replace(/0+$/, "")
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole
}
