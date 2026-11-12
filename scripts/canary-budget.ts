// The canary's spend accounting, kept apart so it is tested without sending anything. A call is made only when the
// spend so far plus that call's worst case fits the budget, so a run can never overshoot --budget-usd by its own
// accounting. After a call, its reported charge is counted when the answer states one, whatever the HTTP status;
// otherwise the worst case is counted, because an unknown charge is not zero.
import { decimalOf, JsonNumber, parseJson } from "../src/domain/json.js"
import { add, compare, format, max, money, roundUp, zero, type Money } from "../src/domain/money.js"

export class CanaryBudget {
  private spent: Money = zero()
  constructor(
    readonly budget: Money,
    /** The most one call may cost, as the person running the canary judges it. */
    readonly perCall: Money,
  ) {}

  /** True when one more call, at its worst case, still fits the budget. Checked BEFORE each POST. */
  canAfford() {
    return compare(add(this.spent, this.perCall), this.budget) <= 0
  }

  /** Counts a finished call: the reported charge if there is one, else the worst case. Returns what was counted. */
  record(reported: string | undefined) {
    const charge = reported === undefined ? this.perCall : max(money(reported), zero())
    this.spent = add(this.spent, charge)
    return format(charge)
  }

  /** Counts a call whose answer may carry usage even on an error status (`usage.cost` in a JSON body). */
  recordAnswer(body: Uint8Array | undefined) {
    return this.record(body === undefined ? undefined : reportedCost(body))
  }

  get total() {
    return format(this.spent)
  }
}

/** `usage.cost` from any JSON answer, exactly and rounded up, or undefined when the answer states none. */
export function reportedCost(body: Uint8Array): string | undefined {
  try {
    const document = parseJson(new TextDecoder().decode(body))
    if (typeof document !== "object" || document === null || Array.isArray(document) || document instanceof JsonNumber) return undefined
    const usage = new Map(Object.entries(document)).get("usage")
    if (typeof usage !== "object" || usage === null || Array.isArray(usage) || usage instanceof JsonNumber) return undefined
    const cost = new Map(Object.entries(usage)).get("cost")
    const decimal = cost instanceof JsonNumber ? decimalOf(cost) : undefined
    return decimal === undefined || !/^\d{1,12}(?:\.\d+)?$/.test(decimal) ? undefined : format(roundUp(decimal, 12))
  } catch {
    return undefined
  }
}
