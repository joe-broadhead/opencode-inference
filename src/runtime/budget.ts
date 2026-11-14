import { InferenceError } from "../domain/errors.js"
import { add, compare, format, min, money, sum, zero, type Money } from "../domain/money.js"
import type { OperationRecord } from "./journal.js"

// Budgets (handoff §11.2, §12). Every cap is opt-in: with none set (the default) a call is admitted at any price, and
// each result still reports what it cost. A cap that is set works as follows. Operation-keyed reservations, never a
// session's "last estimate":
//
// - Before dispatch, each operation reserves an amount and the journal persists it, under the journal's process mutex
//   and cross-process lock, after checking committed plus pending spend at every scope that has a cap: the request,
//   the session and the rolling 24 hours. Two processes cannot both admit reservations that together pass a scope.
// - The amount is the route's upper bound when one is known. An estimate is not a cap, so with only an estimate (or no
//   price, when the options allow that) the operation reserves the whole effective per-request budget when one is set,
//   which is then an admission limit, not a spend ceiling: the provider enforces no ceiling of ours. With no
//   per-request budget, it reserves the top of the estimate; an unpriced call is refused while a session or rolling cap
//   is set, because nothing could count it against that cap, and reserves nothing otherwise.
// - Settlement replaces the reservation with the reported charges. A call whose cost cannot be determined keeps its
//   reservation ("retained"): failure does not mean zero cost. Only a call that certainly never left releases it.
//
// The caps are trusted options and budgets, not prices. Their scope is this machine's journal for one OpenRouter
// connection: not an account-wide limit across machines or other clients, and OpenRouter's own key limits remain the
// stronger, independent boundary.

/** The spend options. A cap that is `null` is not set: that scope has no limit. */
export interface SpendLimits {
  readonly requestUsd: string | null
  readonly sessionUsd: string | null
  readonly rolling24hUsd: string | null
  readonly requirePricedRoute: boolean
  readonly requireUpperBound: boolean
}

/** What the adapter can say about a call's price before sending it. */
export interface Quote {
  readonly kind: "upper_bound" | "estimate" | "unavailable"
  /** The upper bound, or the top of the estimate. USD. */
  readonly amount?: string
}

export interface Reservation {
  readonly amount: Money
  /**
   * `upper_bound`: the route's own ceiling. `admission_budget`: what is reserved without one: the effective per-request
   * budget, reserved whole, when one is set; otherwise the top of the estimate, or nothing for an unpriced call.
   */
  readonly basis: "upper_bound" | "admission_budget"
}

export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000

/** The per-request reservation, or the refusal: PRICE_UNKNOWN in strict modes, BUDGET_EXCEEDED over the request cap. */
export function reservationFor(quote: Quote, limits: SpendLimits, requested?: string): Reservation {
  // A tool input can lower the trusted per-request budget, never raise it; with none set, the input's is the budget.
  const caps = [limits.requestUsd, requested].filter((value): value is string => value !== undefined && value !== null).map((value) => money(value))
  const cap = caps.length === 0 ? undefined : caps.reduce((left, right) => min(left, right))
  if (quote.kind === "unavailable" || quote.amount === undefined) {
    if (limits.requirePricedRoute || limits.requireUpperBound) throw new InferenceError("PRICE_UNKNOWN", "No price is known for this route, and the spend options require one.")
    if (cap !== undefined) return { amount: cap, basis: "admission_budget" }
    if (limits.sessionUsd !== null || limits.rolling24hUsd !== null)
      throw new InferenceError("PRICE_UNKNOWN", "No price is known for this route, so nothing could count it against the session or rolling 24-hour cap you set; set spend.requestUsd to admit it.")
    return { amount: zero(), basis: "admission_budget" }
  }
  if (quote.kind === "estimate" && limits.requireUpperBound)
    throw new InferenceError("PRICE_UNKNOWN", "This route has only an estimate, not an upper bound, and spend.requireUpperBound is on.")
  const quoted = money(quote.amount)
  if (cap !== undefined && compare(quoted, cap) > 0)
    throw new InferenceError("BUDGET_EXCEEDED", `This call's ${quote.kind === "upper_bound" ? "upper bound" : "estimate"} of USD ${format(quoted)} is over the per-request budget of USD ${format(cap)}.`)
  return quote.kind === "upper_bound" ? { amount: quoted, basis: "upper_bound" } : { amount: cap ?? quoted, basis: "admission_budget" }
}

/** What one record counts against a scope, in USD. */
export function counted(record: OperationRecord): Money {
  const reserved = money(record.reservation.amount)
  switch (record.reservation.status) {
    case "released":
      return zero()
    case "held":
    case "retained":
      return reserved
    case "settled":
      return sum(record.charges.filter((charge) => charge.currency === "USD").map((charge) => money(charge.amount)))
  }
}

export interface SpendTotals {
  /** Settled, reported charges. */
  readonly committed: string
  /** Held for operations in flight. */
  readonly reserved: string
  /** Retained for operations whose cost is unknown. */
  readonly unknown: string
}

export function totals(records: readonly OperationRecord[]): SpendTotals {
  const of = (status: OperationRecord["reservation"]["status"]) => format(sum(records.filter((record) => record.reservation.status === status).map(counted)))
  return { committed: of("settled"), reserved: of("held"), unknown: of("retained") }
}

/**
 * Admission: throws BUDGET_EXCEEDED, naming the scope, when the new reservation plus everything already counted would
 * pass the session or the rolling 24-hour budget, for each one that is set; with neither set it admits every call. Called inside the journal's lock, so the check and the write are one
 * step for every process sharing the journal.
 */
export function admit(records: readonly OperationRecord[], draft: { readonly sessionId: string; readonly amount: Money }, limits: SpendLimits, now: Date) {
  const since = now.getTime() - ROLLING_WINDOW_MS
  const scopes = [
    { name: "session", limit: limits.sessionUsd, records: () => records.filter((record) => record.initiatedBy.sessionId === draft.sessionId) },
    { name: "rolling 24-hour", limit: limits.rolling24hUsd, records: () => records.filter((record) => Date.parse(record.createdAt) >= since) },
  ].flatMap((scope) => (scope.limit === null ? [] : [{ name: scope.name, limit: money(scope.limit), records: scope.records() }]))
  for (const scope of scopes) {
    const used = sum(scope.records.map(counted))
    if (compare(add(used, draft.amount), scope.limit) > 0)
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `This call would reserve USD ${format(draft.amount)}, but USD ${format(used)} of the ${scope.name} budget of USD ${format(scope.limit)} is already committed, reserved or unknown.`,
      )
  }
}
