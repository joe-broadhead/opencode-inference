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
    [["--yes-spend", "--budget-usd", "0.02"], {}, /OPENROUTER_CANARY_KEY is not set/],
    [["--yes-spend", "--budget-usd", "0.5"], KEY, /above the canary's ceiling of 0\.10/],
    [["--yes-spend", "--budget-usd", "0"], KEY, /must be above zero/],
    [["--yes-spend", "--budget-usd", "1e-2"], KEY, /must be an exact decimal/],
    [["--yes-spend", "--budget-usd", "0.02", "--only", "everything"], KEY, /unknown canary everything/],
    [["--yes-spend", "--budget-usd", "0.02", "--force"], KEY, /unknown option --force/],
    [["--yes-spend", "--budget-usd", "0.02"], { ...KEY, CI: "true" }, /CI is set/],
  ]
  for (const [args, env, message] of cases) {
    const result = run(args, env)
    expect({ args, code: result.code }).toEqual({ args, code: 2 })
    expect(result.err).toMatch(message)
    expect(result.out).toBe("")
  }
})

test("a dry run prints what would be sent and sends nothing", () => {
  const result = run(["--yes-spend", "--budget-usd", "0.02", "--dry-run"], KEY)
  expect(result.code).toBe(0)
  const report = JSON.parse(result.out) as { results: { canary: string; would: string }[]; next: string; catalog: { would: string } }
  expect(report.results.map((item) => [item.canary, item.would])).toEqual([
    ["text", "POST /api/alpha/extractions"],
    ["image", "POST /api/alpha/extractions"],
    ["pdf", "POST /api/alpha/extractions"],
    ["malformed", "POST /api/alpha/extractions"],
  ])
  expect(report.catalog.would).toMatch(/no key/)
  expect(report.next).toBe("Dry run: nothing was sent.")
  expect(result.out).not.toContain(KEY.OPENROUTER_CANARY_KEY)
}, 30_000)
