// The canaries' --shape option: a live answer's structure and the adapter's exact refusal go into the report, never a
// value, the source text or the key; and --shape adds no request, so the budget rules are unchanged.
import { expect, test } from "bun:test"
import { ExtractInput, DecideInput } from "../../src/domain/contracts.js"
import { loadConfig } from "../../src/domain/config.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { decisionsAdapter } from "../../src/providers/openrouter/decisions.js"
import { extractionsAdapter, WIRE_REVISION } from "../../src/providers/openrouter/extractions.js"
import { snapshot, type FileAccess } from "../../src/runtime/sources.js"
import { failureOf, shapeOf } from "../../scripts/canary-shape.js"

const SOURCE = "Total EUR 1.00, paid by Zoé"
const KEY = "sk-or-v1-canary-shape-test-not-a-key"
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))
const answer = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: encode(body), elapsedMs: 3 })

test("a shape keeps paths, types and lengths, and status words only under status keys; never a value, the text or the key", () => {
  const live = {
    id: "gen-abc",
    object: "extraction",
    model: "cloudflare/clairic",
    result: { total: { value: "1.00", confidence: 0.93, evidence: [{ start: 6, end: 14, text: SOURCE }, { start: 0, end: 5 }], status: "ok" } },
    usage: { cost: 0.0000125, prompt_tokens: 12 },
    error: { type: "Total EUR 1.00", message: `bad key ${KEY}`, code: 400 },
    [SOURCE]: true,
  }
  const shape = shapeOf(answer(live))
  const text = JSON.stringify(shape)
  for (const secret of [SOURCE, "1.00", "Zoé", KEY, "0.93", "0.0000125", "gen-abc"]) expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false })
  expect(shape).toMatchObject({ status: 200, contentType: "application/json", json: true, truncated: false })
  const at = (path: string) => shape.entries.filter((entry) => entry.path === path)
  expect(at("$")).toEqual([{ path: "$", type: "object", length: 7 }])
  expect(at("$.object")).toEqual([{ path: "$.object", type: "string", length: 10, value: "extraction" }])
  expect(at("$.result.total.value")).toEqual([{ path: "$.result.total.value", type: "string", length: 4 }])
  expect(at("$.result.total.confidence")).toEqual([{ path: "$.result.total.confidence", type: "number" }])
  expect(at("$.result.total.status")).toEqual([{ path: "$.result.total.status", type: "string", length: 2, value: "ok" }])
  expect(at("$.result.total.evidence")).toEqual([{ path: "$.result.total.evidence", type: "array", length: 2 }])
  // Items of a list share one path, with the range of their key counts.
  expect(at("$.result.total.evidence[]")).toEqual([{ path: "$.result.total.evidence[]", type: "object", length: [2, 3] }])
  expect(at("$.result.total.evidence[].start")).toEqual([{ path: "$.result.total.evidence[].start", type: "integer" }])
  // A status-like key with a value that is not one short word keeps only its type.
  expect(at("$.error.type")).toEqual([{ path: "$.error.type", type: "string", length: 14 }])
  expect(at("$.error.message")).toEqual([{ path: "$.error.message", type: "string", length: 8 + KEY.length }])
  // A key that is not a plain identifier is shown by its position.
  expect(at("$.<key 6>")).toEqual([{ path: "$.<key 6>", type: "boolean" }])
})

test("a body that is not JSON has no entries; a deep or wide answer is bounded and says so", () => {
  expect(shapeOf({ status: 502, contentType: "text/html", body: encode(`<html>${SOURCE}</html>`) })).toEqual({ status: 502, contentType: "text/html", bytes: encode(`<html>${SOURCE}</html>`).byteLength, json: false, entries: [], truncated: false })
  let deep: unknown = 1
  for (let index = 0; index < 20; index++) deep = { a: deep }
  expect(shapeOf(answer(deep)).truncated).toBe(true)
  const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]))
  const shape = shapeOf(answer(wide))
  expect(shape.truncated).toBe(true)
  expect(shape.entries).toHaveLength(400)
})

test("the adapter's exact refusal: its path, what it expects, and the type found there", async () => {
  const clairic = OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "cloudflare/clairic")!
  const source = await snapshot({ kind: "text", text: SOURCE }, {} as FileAccess, clairic, new AbortController().signal)
  const input = ExtractInput.parse({ model: "cloudflare/clairic", source: { kind: "text", text: SOURCE }, fields: { total: { type: "number", decimals: 2 } } })
  const refusal = (body: unknown) => {
    const response = answer(body)
    try {
      extractionsAdapter.parse(response, { source, route: clairic, input })
    } catch (error) {
      return failureOf(error, response.body)
    }
    throw new Error("the adapter accepted it")
  }
  expect(refusal({ model: "cloudflare/clairic", answers: { total: { type: "number", value: 1, confidence: "high" } } })).toEqual({
    code: "PROVIDER_CONTRACT_CHANGED",
    message: `OpenRouter's extraction answer does not match the reviewed contract (${WIRE_REVISION}): answers.total.confidence is not a probability.`,
    path: "answers.total.confidence",
    expected: "is not a probability",
    received: "string",
  })
  // A shape the adapter never saw: the answers live somewhere else.
  expect(refusal({ model: "cloudflare/clairic", result: { total: { value: "1.00" } } })).toMatchObject({ path: "answers", expected: "is missing or not an object", received: "missing" })
  // A missing documented key: the path and "missing".
  expect(refusal({ model: "cloudflare/clairic", answers: { total: { value: 1 } } })).toMatchObject({ path: "answers.total.type", expected: "is not number", received: "missing" })
  // A refusal that names no path keeps only the code and the message.
  expect(refusal({ model: "another/model", answers: {} })).toEqual({ code: "PROVIDER_CONTRACT_CHANGED", message: expect.stringMatching(/the answer came from another model\.$/) })

  const jev = { ...OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "typesafe/jev-1.14")!, effectiveContextTokens: 2048, contextAllowance: { tokens: 1024, source: "test" } }
  const decide = decisionsAdapter.prepare!(DecideInput.parse({ model: jev.model, source: { kind: "text", text: SOURCE }, questions: { paid: { type: "noul", prompt: "Paid?" } } }), loadConfig({}))
  const decideSource = await snapshot({ kind: "text", text: SOURCE }, {} as FileAccess, jev, new AbortController().signal)
  const response = answer({ model: jev.model, answers: { paid: { type: "noul", noul: [0.9] } } })
  let failure: ReturnType<typeof failureOf> | undefined
  try {
    decisionsAdapter.parse(response, { source: decideSource, route: jev, input: decide })
  } catch (error) {
    failure = failureOf(error, response.body)
  }
  expect(failure).toMatchObject({ code: "PROVIDER_CONTRACT_CHANGED", path: "answers.paid.noul", received: "array" })
  // Anything but the plugin's own error is reported by its name only.
  expect(failureOf(new TypeError(`boom ${SOURCE}`), undefined)).toEqual({ code: "error", message: "TypeError" })
})

test("--shape is accepted by both canaries and adds no request: a dry run sends nothing and counts the same", () => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "OPENROUTER_CANARY_KEY"))
  for (const script of ["canary-extractions", "canary-decisions"]) {
    const run = (extra: string[]) => {
      const child = Bun.spawnSync([process.execPath, new URL(`../../scripts/${script}.ts`, import.meta.url).pathname, "--yes-spend", "--budget-usd", "0.10", "--per-call-usd", "0.02", "--dry-run", ...extra], {
        env: { ...base, OPENROUTER_CANARY_KEY: KEY } as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect({ script, extra, code: child.exitCode, err: child.stderr.toString() }).toEqual({ script, extra, code: 0, err: "" })
      return JSON.parse(child.stdout.toString()) as { shape: boolean; spentUsd: string; results: { would?: string; shape?: string }[]; next: string }
    }
    const plain = run([])
    const shaped = run(["--shape"])
    expect({ script, plain: plain.shape, shaped: shaped.shape }).toEqual({ script, plain: false, shaped: true })
    expect(shaped.spentUsd).toBe(plain.spentUsd)
    expect(shaped.results.map((item) => item.would)).toEqual(plain.results.map((item) => item.would))
    expect(shaped.results.every((item) => item.shape === "would record the answer's structure")).toBe(true)
    expect(shaped.next).toBe("Dry run: nothing was sent.")
  }
}, 60_000)
