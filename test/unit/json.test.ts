import { describe, expect, test } from "bun:test"
import { decimalOf, JsonNumber, parseJson, type Json } from "../../src/domain/json.js"

describe("exact JSON", () => {
  test("keeps every number as the literal the provider wrote", () => {
    const parsed = parseJson('{"cost": 0.000012345678901234, "total": 120.10, "n": -3, "e": 1.5e-7, "list": [1, 2.50]}') as Record<string, Json>
    expect((parsed.cost as JsonNumber).text).toBe("0.000012345678901234")
    expect((parsed.total as JsonNumber).text).toBe("120.10")
    expect(((parsed.list as Json[])[1] as JsonNumber).text).toBe("2.50")
    // JSON.parse would have turned these into floats.
    expect(String(JSON.parse("120.10"))).toBe("120.1")
    expect(String(JSON.parse("0.30000000000000000001"))).toBe("0.3")
  })

  test("converts a number to an exact plain decimal, exponents included", () => {
    const cases: [string, string | undefined][] = [
      ["0", "0"],
      ["120.10", "120.1"],
      ["1.5e-7", "0.00000015"],
      ["15E-8", "0.00000015"],
      ["2.5e3", "2500"],
      ["0.000012345678901234", "0.000012345678901234"],
      ["7e0", "7"],
      ["-1", undefined],
    ]
    for (const [text, decimal] of cases) expect(decimalOf(new JsonNumber(text))).toBe(decimal)
  })

  test("refuses what JSON refuses, duplicate keys, and documents nested too deeply", () => {
    for (const bad of ['{"a":1,"a":2}', "{a:1}", "[1,]", "NaN", "01", '"\u0001"', "1 2", "{\"a\":1", "[" .repeat(70) + "]".repeat(70), "'x'", "Infinity"])
      expect(() => parseJson(bad)).toThrow(/^PROVIDER_CONTRACT_CHANGED: OpenRouter's answer is not valid JSON/)
  })

  test("a __proto__ key is an own property, never a prototype", () => {
    const parsed = parseJson('{"__proto__": {"polluted": true}}') as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(["__proto__"])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined()
  })
})
