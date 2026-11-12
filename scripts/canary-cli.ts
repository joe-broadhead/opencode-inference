// The arguments every opt-in canary takes, checked the same way: an explicit key from OPENROUTER_CANARY_KEY, a budget of
// at most 0.10, a per-call worst case of at most the budget, --yes-spend, never in CI. Anything missing exits 2 before
// any request exists.
import { compare, money, type Money } from "../src/domain/money.js"
import { CanaryBudget } from "./canary-budget.js"

export const MAX_BUDGET = money("0.10")

export interface CanaryArgs<C extends string> {
  readonly key: string
  readonly budget: Money
  readonly perCall: Money
  readonly spend: CanaryBudget
  readonly selected: ReadonlySet<C>
  readonly dryRun: boolean
}

export function canaryArgs<C extends string>(script: string, canaries: readonly C[], argv: readonly string[], env: NodeJS.ProcessEnv): CanaryArgs<C> {
  const refuse = (reason: string): never => {
    console.error(`${script}: refused: ${reason}`)
    console.error(`usage: OPENROUTER_CANARY_KEY=<key> bun scripts/${script}.ts --budget-usd <at most 0.10> --per-call-usd <worst case per call> --yes-spend [--only ${canaries.join(",")}] [--dry-run]`)
    process.exit(2)
  }
  const flag = (name: string) => argv.includes(name)
  const value = (name: string) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  const amount = (name: string, example: string) => {
    const text = value(name)
    if (text === undefined) return undefined
    try {
      return money(text)
    } catch {
      return refuse(`${name} must be an exact decimal such as ${example}`)
    }
  }
  for (const arg of argv) if (arg.startsWith("--") && !["--budget-usd", "--per-call-usd", "--yes-spend", "--only", "--dry-run"].includes(arg)) refuse(`unknown option ${arg}`)
  if (env.CI) refuse("CI is set: the canary spends money and never runs in CI")
  if (!flag("--yes-spend")) refuse("--yes-spend is required: the canary sends requests that are charged")
  const budget = amount("--budget-usd", "0.02") ?? refuse("--budget-usd is required")
  if (compare(budget, MAX_BUDGET) > 0) refuse("--budget-usd is above the canary's ceiling of 0.10")
  if (budget.units === 0n) refuse("--budget-usd must be above zero")
  const perCall = amount("--per-call-usd", "0.005") ?? refuse("--per-call-usd is required: the worst case of one call, checked before each call")
  if (perCall.units === 0n || compare(perCall, budget) > 0) refuse("--per-call-usd must be above zero and at most --budget-usd")
  const key = env.OPENROUTER_CANARY_KEY
  if (!key) refuse("OPENROUTER_CANARY_KEY is not set: the canary uses only an explicitly given key, never OpenCode's")
  const only = (value("--only") ?? canaries.join(",")).split(",")
  for (const name of only) if (!(canaries as readonly string[]).includes(name)) refuse(`unknown canary ${name}`)
  return { key: key!, budget, perCall, spend: new CanaryBudget(budget, perCall), selected: new Set(only as C[]), dryRun: flag("--dry-run") }
}
