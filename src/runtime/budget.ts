import { InferenceError } from "../domain/errors.js"
import { add, compare, format, min, money, sum, zero, type Money } from "../domain/money.js"
import type { OperationRecord } from "./journal.js"

// Budgets (handoff §11.2, §12). Operation-keyed reservations, never a session's "last estimate":
//
// - Before dispatch, each operation reserves an amount and the journal persists it, under the journal's process mutex
//   and cross-process lock, after checking committed plus pending spend at every scope: the request, the session and
//   the rolling 24 hours. Two processes cannot both admit reservations that together pass a scope.
// - The amount is the route's upper bound when one is known. An estimate is not a cap, so with only an estimate (or no
//   price, when the options allow that) the operation reserves the whole effective per-request budget, which is then an
//   admission limit, not a spend ceiling: the provider enforces no ceiling of ours.
// - Settlement replaces the reservation with the reported charges. A call whose cost cannot be determined keeps its
//   reservation ("retained"): failure does not mean zero cost. Only a call that certainly never left releases it.
//
// The defaults (request USD 0.05, session USD 1.00, rolling 24 hours USD 5.00) are confirmed by the owner. They are
// budgets, not prices. All three are trusted options. The scope
// is this machine's journal for one OpenRouter connection: it is not an account-wide limit across machines or other
// clients, and OpenRouter's own key limits remain the stronger, independent boundary.

export interface SpendLimits {
  readonly requestUsd: string
  readonly sessionUsd: string
  readonly rolling24hUsd: string
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
  /** `upper_bound`: the route's own ceiling. `admission_budget`: the effective per-request budget, reserved whole. */
  readonly basis: "upper_bound" | "admission_budget"
}

export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000

/** The per-request reservation, or the refusal: PRICE_UNKNOWN in strict modes, BUDGET_EXCEEDED over the request cap. */
export function reservationFor(quote: Quote, limits: SpendLimits, requested?: string): Reservation {
  // A tool input can lower the trusted per-request budget, never raise it.
  const cap = requested === undefined ? money(limits.requestUsd) : min(money(limits.requestUsd), money(requested))
  if (quote.kind === "unavailable" || quote.amount === undefined) {
    if (limits.requirePricedRoute || limits.requireUpperBound) throw new InferenceError("PRICE_UNKNOWN", "No price is known for this route, and the spend options require one.")
    return { amount: cap, basis: "admission_budget" }
  }
  if (quote.kind === "estimate" && limits.requireUpperBound)
    throw new InferenceError("PRICE_UNKNOWN", "This route has only an estimate, not an upper bound, and spend.requireUpperBound is on.")
  const quoted = money(quote.amount)
  if (compare(quoted, cap) > 0)
    throw new InferenceError("BUDGET_EXCEEDED", `This call's ${quote.kind === "upper_bound" ? "upper bound" : "estimate"} of USD ${format(quoted)} is over the per-request budget of USD ${format(cap)}.`)
  return quote.kind === "upper_bound" ? { amount: quoted, basis: "upper_bound" } : { amount: cap, basis: "admission_budget" }
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
 * pass the session or the rolling 24-hour budget. Called inside the journal's lock, so the check and the write are one
 * step for every process sharing the journal.
 */
export function admit(records: readonly OperationRecord[], draft: { readonly sessionId: string; readonly amount: Money }, limits: SpendLimits, now: Date) {
  const since = now.getTime() - ROLLING_WINDOW_MS
  const scopes = [
    { name: "session", limit: money(limits.sessionUsd), records: records.filter((record) => record.initiatedBy.sessionId === draft.sessionId) },
    { name: "rolling 24-hour", limit: money(limits.rolling24hUsd), records: records.filter((record) => Date.parse(record.createdAt) >= since) },
  ]
  for (const scope of scopes) {
    const used = sum(scope.records.map(counted))
    if (compare(add(used, draft.amount), scope.limit) > 0)
      throw new InferenceError(
        "BUDGET_EXCEEDED",
        `This call would reserve USD ${format(draft.amount)}, but USD ${format(used)} of the ${scope.name} budget of USD ${format(scope.limit)} is already committed, reserved or unknown.`,
      )
  }
}
