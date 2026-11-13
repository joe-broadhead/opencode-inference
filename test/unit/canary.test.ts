// The opt-in canary refuses to run without an explicit key, a budget and an acknowledgement, and never in CI. These
// tests run only its refusals and its dry run, which send nothing.
import { expect, test } from "bun:test"

const SCRIPT = new URL("../../scripts/canary-extractions.ts", import.meta.url).pathname
const run = (args: string[], env: Record<string, string | undefined> = {}) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "OPENROUTER_CANARY_KEY"))
  const child = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...base, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" })
  return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() }
}
const KEY = { OPENROUTER_CANARY_KEY: "sk-or-v1-canary-test-not-a-key" }

test("refuses without --yes-spend, a budget, a key, within the ceiling, and refuses in CI", () => {
  const cases: [string[], Record<string, string>, RegExp][] = [
    [[], KEY, /--yes-spend is required/],
    [["--yes-spend"], KEY, /--budget-usd is required/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01"], {}, /OPENROUTER_CANARY_KEY is not set/],
    [["--yes-spend", "--budget-usd", "0.02"], KEY, /--per-call-usd is required/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.03"], KEY, /at most --budget-usd/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0"], KEY, /above zero/],
    [["--yes-spend", "--budget-usd", "0.5"], KEY, /above the canary's ceiling of 0\.10/],
    [["--yes-spend", "--budget-usd", "0"], KEY, /must be above zero/],
    [["--yes-spend", "--budget-usd", "1e-2"], KEY, /must be an exact decimal/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01", "--only", "everything"], KEY, /unknown canary everything/],
    [["--yes-spend", "--budget-usd", "0.02", "--force"], KEY, /unknown option --force/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01"], { ...KEY, CI: "true" }, /CI is set/],
  ]
  for (const [args, env, message] of cases) {
    const result = run(args, env)
    expect({ args, code: result.code }).toEqual({ args, code: 2 })
    expect(result.err).toMatch(message)
    expect(result.out).toBe("")
  }
})

test("a dry run prints what would be sent, checks each call's worst case first, and sends nothing", () => {
  // A budget of 0.02 at 0.01 a call covers two calls: the third and fourth are skipped before they would be sent.
  const result = run(["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01", "--dry-run"], KEY)
  expect(result.code).toBe(0)
  const report = JSON.parse(result.out) as { results: { canary: string; would?: string; skipped?: string }[]; next: string; catalog: { would: string }; spentUsd: string }
  expect(report.results.map((item) => [item.canary, item.would ?? item.skipped])).toEqual([
    ["text", "POST /api/alpha/extractions"],
    ["image", "POST /api/alpha/extractions"],
    ["pdf", "the remaining budget cannot cover this call's worst case"],
    ["malformed", "the remaining budget cannot cover this call's worst case"],
  ])
  expect(report.spentUsd).toBe("0.02")
  expect(report.catalog.would).toMatch(/no key/)
  expect(report.next).toBe("Dry run: nothing was sent.")
  expect(result.out).not.toContain(KEY.OPENROUTER_CANARY_KEY)
}, 30_000)

test("the budget counts reported charges on any status, the worst case when none is reported, and never lets a call overshoot", async () => {
  const { CanaryBudget, reportedCost } = await import("../../scripts/canary-budget.js")
  const { money } = await import("../../src/domain/money.js")
  const budget = new CanaryBudget(money("0.03"), money("0.01"))
  const body = (text: string) => new TextEncoder().encode(text)
  expect(budget.canAfford()).toBe(true)
  // A 402 or 500 answer that reports usage is counted by what it reports, read exactly and rounded up.
  expect(budget.recordAnswer(body('{"error":{"code":402},"usage":{"cost":0.0000000000001}}'))).toBe("0.000000000001")
  // An error answer without usage, or no answer at all, counts the worst case.
  expect(budget.recordAnswer(body('{"error":"boom"}'))).toBe("0.01")
  expect(budget.recordAnswer(undefined)).toBe("0.01")
  expect(budget.total).toBe("0.020000000001")
  // 0.020000000001 + 0.01 would pass 0.03: the next call is refused BEFORE it is made.
  expect(budget.canAfford()).toBe(false)
  expect(reportedCost(body("not json"))).toBeUndefined()
  expect(reportedCost(body('{"usage":{"cost":"0.1"}}'))).toBeUndefined()
})

test("the Decisions canary refuses the same way, and its dry run sends nothing", () => {
  const SCRIPT_DECISIONS = new URL("../../scripts/canary-decisions.ts", import.meta.url).pathname
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "OPENROUTER_CANARY_KEY"))
  const go = (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawnSync([process.execPath, SCRIPT_DECISIONS, ...args], { env: { ...base, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" })
    return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() }
  }
  for (const [args, env, message] of [
    [[], KEY, /--yes-spend is required/],
    [["--yes-spend", "--budget-usd", "0.02"], KEY, /--per-call-usd is required/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01"], {}, /OPENROUTER_CANARY_KEY is not set/],
    [["--yes-spend", "--budget-usd", "0.2", "--per-call-usd", "0.01"], KEY, /ceiling of 0\.10/],
    [["--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01"], { ...KEY, CI: "1" }, /CI is set/],
  ] as [string[], Record<string, string>, RegExp][]) {
    const result = go(args, env)
    expect({ args, code: result.code }).toEqual({ args, code: 2 })
    expect(result.err).toMatch(message)
  }
  const dry = go(["--yes-spend", "--budget-usd", "0.01", "--per-call-usd", "0.01", "--dry-run"], KEY)
  expect(dry.code).toBe(0)
  const report = JSON.parse(dry.out) as { results: { canary: string; would?: string; skipped?: string }[]; next: string }
  expect(report.results.map((item) => [item.canary, item.would ?? item.skipped])).toEqual([
    ["text", "POST /api/alpha/decisions"],
    ["malformed", "the remaining budget cannot cover this call's worst case"],
  ])
  expect(report.next).toBe("Dry run: nothing was sent.")
  expect(dry.out).not.toContain(KEY.OPENROUTER_CANARY_KEY)
}, 30_000)

test("every report names the wire revision it checks and the commit it ran from, and no path", async () => {
  const { WIRE_REVISION: EXTRACTIONS } = await import("../../src/providers/openrouter/extractions.js")
  const { WIRE_REVISION: DECISIONS } = await import("../../src/providers/openrouter/decisions.js")
  const repo = new URL("../../", import.meta.url).pathname
  for (const [script, revision] of [["canary-extractions", EXTRACTIONS], ["canary-decisions", DECISIONS]] as const) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "CI" && name !== "OPENROUTER_CANARY_KEY"))
    const child = Bun.spawnSync([process.execPath, new URL(`../../scripts/${script}.ts`, import.meta.url).pathname, "--yes-spend", "--budget-usd", "0.02", "--per-call-usd", "0.01", "--only", "malformed", "--dry-run"], {
      env: { ...base, ...KEY } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect({ script, code: child.exitCode }).toEqual({ script, code: 0 })
    const out = child.stdout.toString()
    const report = JSON.parse(out) as { wireRevision: string; commit: string; dirty: unknown }
    expect({ script, wireRevision: report.wireRevision }).toEqual({ script, wireRevision: revision })
    // This suite runs in a git checkout: the commit is the checkout's HEAD.
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim()
    expect(report.commit).toBe(head)
    expect(report.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(typeof report.dirty).toBe("boolean")
    expect(out).not.toContain(repo.replace(/\/$/, ""))
    expect(out).not.toContain(KEY.OPENROUTER_CANARY_KEY)
  }
}, 60_000)
