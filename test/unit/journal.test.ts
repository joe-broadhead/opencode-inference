// The operation journal, its lock and the budget arithmetic: exact money, admission across REAL child processes,
// crash recovery that never steals a lock, and a journal that is never silently reset.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { InferenceError } from "../../src/domain/errors.js"
import { add, compare, format, money, roundUp, sum } from "../../src/domain/money.js"
import { createJournalStore, OWNER } from "../../src/host/journal-store.js"
import { admit, reservationFor, totals } from "../../src/runtime/budget.js"
import { Journal, JournalDocument } from "../../src/runtime/journal.js"
import { draft, limits, SCOPE } from "../support/journal-child.js"
import { tempRoot } from "../support/temp.js"

const CHILD = new URL("../support/journal-child.ts", import.meta.url).pathname
const run = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, CHILD, ...args], { stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`child failed (${code}): ${stderr}`)
  return { output: JSON.parse(stdout.trim()) as Record<string, unknown>, pid: child.pid }
}
const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    return error as InferenceError
  }
  throw new Error("expected a failure")
}

describe("money", () => {
  test("is exact to 12 places and never a float", () => {
    expect(format(add(money("0.1"), money("0.2")))).toBe("0.3")
    expect(format(sum(Array.from({ length: 10 }, () => money("0.1"))))).toBe("1")
    // xAI's ticks: 10^10 per dollar.
    expect(format(add(money("0.0000000001"), money("0.0000000002")))).toBe("0.0000000003")
    expect(compare(money("1.000000000001"), money("1"))).toBe(1)
    for (const bad of ["1e-3", "-1", ".5", "1.", "0.1234567890123", "NaN", "01"]) expect(() => money(bad)).toThrow()
    expect(() => add(money("1", "USD"), money("1", "credits"))).toThrow(/cannot combine/)
    // Too fine for 12 places: a coded error, not a raw RangeError.
    expect(() => money("0.0000000000001")).toThrow(/^PROVIDER_CONTRACT_CHANGED: An amount is not an exact non-negative decimal/)
    expect(() => reservationFor({ kind: "upper_bound", amount: "0.0000000000001" }, limits("1"))).toThrow(InferenceError)
  })

  test("roundUp rounds any precision up, never down, to at most 12 places", () => {
    expect(format(roundUp("0.0000000000001"))).toBe("0.000000000001")
    expect(format(roundUp("0.000000000000000000001"))).toBe("0.000000000001")
    expect(format(roundUp("1.23456", 2))).toBe("1.24")
    expect(format(roundUp("1.2", 2))).toBe("1.2")
    expect(format(roundUp("1.2300000000000000000", 2))).toBe("1.23")
    expect(format(roundUp("0.999", 2))).toBe("1")
    expect(format(roundUp("7", 0))).toBe("7")
    expect(format(roundUp("7.0001", 0))).toBe("8")
    expect(format(roundUp("0.05"))).toBe("0.05")
    // The result is always an exact Money that money() accepts back.
    expect(format(money(format(roundUp("3.1415926535897932384626", 12))))).toBe("3.14159265359")
    for (const bad of ["-1", "1e-3", ".5", "01", "x"]) expect(() => roundUp(bad)).toThrow(/^PROVIDER_CONTRACT_CHANGED:/)
    expect(() => roundUp("1", 13)).toThrow(RangeError)
  })
})

describe("reservations", () => {
  const spend = limits("1.00")
  test("an upper bound reserves itself; an estimate or no price reserves the whole per-request budget", () => {
    expect(reservationFor({ kind: "upper_bound", amount: "0.02" }, spend)).toEqual({ amount: money("0.02"), basis: "upper_bound" })
    expect(reservationFor({ kind: "estimate", amount: "0.02" }, { ...spend, requestUsd: "0.05" })).toEqual({ amount: money("0.05"), basis: "admission_budget" })
    expect(reservationFor({ kind: "unavailable" }, { ...spend, requestUsd: "0.05", requirePricedRoute: false })).toEqual({ amount: money("0.05"), basis: "admission_budget" })
    // A tool input can only lower the per-request budget.
    expect(reservationFor({ kind: "estimate", amount: "0.001" }, { ...spend, requestUsd: "0.05" }, "0.01").amount).toEqual(money("0.01"))
    expect(reservationFor({ kind: "estimate", amount: "0.001" }, { ...spend, requestUsd: "0.05" }, "9").amount).toEqual(money("0.05"))
  })
  test("with no cap set, nothing is refused for its price: an estimate reserves its top, an unpriced call reserves nothing", () => {
    const open = { requestUsd: null, sessionUsd: null, rolling24hUsd: null, requirePricedRoute: false, requireUpperBound: false }
    expect(reservationFor({ kind: "upper_bound", amount: "9" }, open)).toEqual({ amount: money("9"), basis: "upper_bound" })
    expect(reservationFor({ kind: "estimate", amount: "0.02" }, open)).toEqual({ amount: money("0.02"), basis: "admission_budget" })
    expect(reservationFor({ kind: "unavailable" }, open)).toEqual({ amount: money("0"), basis: "admission_budget" })
    // A tool input's budget is the call's cap when no per-request cap is set.
    expect(reservationFor({ kind: "estimate", amount: "0.001" }, open, "0.01").amount).toEqual(money("0.01"))
    expect(() => reservationFor({ kind: "upper_bound", amount: "0.02" }, open, "0.01")).toThrow(/^BUDGET_EXCEEDED:/)
    // An unpriced call cannot be counted against a session or rolling cap you set, so it is refused.
    expect(() => reservationFor({ kind: "unavailable" }, { ...open, sessionUsd: "1" })).toThrow(/^PRICE_UNKNOWN: .*spend\.requestUsd/)
    expect(() => reservationFor({ kind: "unavailable" }, { ...open, rolling24hUsd: "1" })).toThrow(/^PRICE_UNKNOWN:/)
    // requirePricedRoute, on by default, still refuses an unpriced call.
    expect(() => reservationFor({ kind: "unavailable" }, { ...open, requirePricedRoute: true })).toThrow(/^PRICE_UNKNOWN:/)
  })

  test("with no session or rolling cap set, admission admits every call", () => {
    const open = { requestUsd: null, sessionUsd: null, rolling24hUsd: null, requirePricedRoute: true, requireUpperBound: false }
    expect(() => admit([], { sessionId: "ses_a", amount: money("1000000") }, open, new Date())).not.toThrow()
    expect(() => admit([], { sessionId: "ses_a", amount: money("2") }, { ...open, sessionUsd: "1" }, new Date())).toThrow(/^BUDGET_EXCEEDED: .*session budget/)
    expect(() => admit([], { sessionId: "ses_a", amount: money("2") }, { ...open, rolling24hUsd: "1" }, new Date())).toThrow(/^BUDGET_EXCEEDED: .*rolling 24-hour budget/)
  })

  test("strict modes refuse unknown bounds; a bound over the request budget is refused", () => {
    expect(() => reservationFor({ kind: "unavailable" }, spend)).toThrow(/^PRICE_UNKNOWN:/)
    expect(() => reservationFor({ kind: "estimate", amount: "0.01" }, { ...spend, requireUpperBound: true })).toThrow(/^PRICE_UNKNOWN:/)
    expect(() => reservationFor({ kind: "upper_bound", amount: "1.5" }, spend)).toThrow(/^BUDGET_EXCEEDED: .*upper bound of USD 1\.5 is over the per-request budget of USD 1\./)
  })
})

describe("the journal", () => {
  test("is private: a 0700 folder and a 0600 file", async () => {
    const dir = join(tempRoot("journal"), "j")
    await new Journal(createJournalStore(dir), SCOPE).reserve(draft("a", "0.1", "s"), () => undefined)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, "journal.json")).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir, "journal.lock"))).toBe(false)
  })

  test("two processes cannot both admit reservations that exceed the same scope", async () => {
    const dir = join(tempRoot("journal"), "j")
    const startAt = String(Date.now() + 600)
    // Each process tries 15 reservations of USD 0.10 against one USD 1.00 session budget: exactly 10 fit in total.
    const results = await Promise.all([run(["reserve", dir, "15", "0.1", "ses_shared", "1.00", startAt]), run(["reserve", dir, "15", "0.1", "ses_shared", "1.00", startAt])])
    const admitted = results.map((result) => result.output["admitted"] as number)
    expect(admitted.reduce((a, b) => a + b, 0)).toBe(10)
    expect(results.map((result) => result.output["refused"] as number).reduce((a, b) => a + b, 0)).toBe(20)
    // Both children have exited, so this process's recovery turned their dispatching records into submission_unknown:
    // every reservation is still counted.
    const records = await new Journal(createJournalStore(dir), SCOPE).list()
    expect(records).toHaveLength(10)
    expect(new Set(records.map((record) => record.state))).toEqual(new Set(["submission_unknown"]))
    expect(totals(records)).toEqual({ committed: "0", reserved: "0", unknown: "1" })
  }, 30_000)

  test("one process serialises its own transactions with the process mutex, not the lock file", async () => {
    const dir = join(tempRoot("journal"), "j")
    // With no wait for the lock, any contention inside this process would fail.
    const journal = new Journal(createJournalStore(dir, { lockWaitMs: 0 }), SCOPE)
    await Promise.all(Array.from({ length: 25 }, (_, index) => journal.reserve(draft(`i${index}`, "0.01", "s"), (records) => admit(records, { sessionId: "s", amount: money("0.01") }, limits("0.2"), new Date())).catch((error: InferenceError) => error.code)))
    expect(await journal.list()).toHaveLength(20)
  })

  test("crash after reserve: a dead process's dispatching record becomes submission_unknown and keeps its reservation; a planned one is released", async () => {
    const dir = join(tempRoot("journal"), "j")
    const dispatching = await run(["crash-dispatching", dir])
    const planned = await run(["crash-planned", dir])
    const journal = new Journal(createJournalStore(dir), SCOPE)
    const records = await journal.list()
    const byId = new Map(records.map((record) => [record.id, record]))
    expect(byId.get(dispatching.output["id"] as string)).toMatchObject({ state: "submission_unknown", reservation: { status: "retained", amount: "0.25" }, error: { code: "RECOVERED_UNKNOWN" } })
    expect(byId.get(planned.output["id"] as string)).toMatchObject({ state: "failed", reservation: { status: "released" }, error: { code: "RECOVERED_UNSENT" } })
    // The retained reservation still counts, and nothing is resubmitted.
    expect(totals(records)).toEqual({ committed: "0", reserved: "0", unknown: "0.25" })
    expect(() => admit(records, { sessionId: "ses_crash", amount: money("0.1") }, limits("0.3"), new Date())).toThrow(/^BUDGET_EXCEEDED:/)
  }, 30_000)

  test("crash while holding the lock: refused with the owner and a next step, never taken over", async () => {
    const dir = join(tempRoot("journal"), "j")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, "journal.json"), JSON.stringify({ schemaVersion: 1, accountScope: SCOPE, records: [] }))
    const { pid: dead } = await run(["crash-planned", join(tempRoot("journal"), "other")])
    const lock = join(dir, "journal.lock")
    const cases = [
      { holder: { pid: dead, host: OWNER.host, token: "t" }, says: `locked by process ${dead}, which is not running` },
      { holder: { pid: process.pid, host: OWNER.host, token: "t" }, says: `locked by process ${process.pid}, which is running` },
      { holder: { pid: 4242, host: "ffffffffffffffff", token: "t" }, says: "locked by process 4242, whose state is unknown" },
    ]
    for (const { holder, says } of cases) {
      writeFileSync(lock, JSON.stringify(holder))
      const before = readFileSync(join(dir, "journal.json"), "utf8")
      const error = await failure(new Journal(createJournalStore(dir, { lockWaitMs: 50 }), SCOPE).reserve(draft("x", "0.1", "s"), () => undefined))
      expect(error.code).toBe("JOURNAL_LOCKED")
      expect(error.message).toContain(says)
      expect(error.message).toContain("never taken over automatically")
      expect(error.message).toContain(lock)
      expect(error.message).toMatch(/Next step: Make sure no other OpenCode process is using Inference, then remove the lock file named above and retry\.$/)
      expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(holder)
      expect(readFileSync(join(dir, "journal.json"), "utf8")).toBe(before)
    }
  }, 30_000)

  test("a journal that does not parse, or parses but breaks the schema, is refused and never reset", async () => {
    const dir = join(tempRoot("journal"), "j")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, "journal.json")
    // A real record, then the same record with its amount as a binary float.
    const valid = join(tempRoot("journal"), "valid")
    await new Journal(createJournalStore(valid), SCOPE).reserve(draft("x", "0.1", "s"), () => undefined)
    const floated = JSON.parse(readFileSync(join(valid, "journal.json"), "utf8")) as { records: { reservation: { amount: unknown } }[] }
    floated.records[0]!.reservation.amount = 0.1
    const contents = [
      "{not json",
      JSON.stringify({ schemaVersion: 1, accountScope: "openrouter:ffffffffffffffff", records: [] }),
      // Valid JSON, wrong shape: a record missing every field, a future schema version, an amount as a float.
      JSON.stringify({ schemaVersion: 1, accountScope: SCOPE, records: [{ bogus: true }] }),
      JSON.stringify({ schemaVersion: 2, accountScope: SCOPE, records: [] }),
      JSON.stringify(floated),
    ]
    for (const content of contents) {
      writeFileSync(file, content)
      const before = statSync(file, { bigint: true })
      const journal = new Journal(createJournalStore(dir), SCOPE)
      // Neither a read nor a write attempt may replace it, even with an empty journal.
      expect((await failure(journal.list())).code).toBe("JOURNAL_UNREADABLE")
      expect((await failure(journal.reserve(draft("y", "0.1", "s"), () => undefined))).code).toBe("JOURNAL_UNREADABLE")
      const after = statSync(file, { bigint: true })
      expect([after.ino, after.size, after.mtimeNs]).toEqual([before.ino, before.size, before.mtimeNs])
      expect(readFileSync(file, "utf8")).toBe(content)
      expect(readdirSync(dir)).toEqual(["journal.json"])
    }
  })

  test("settle never writes a record that fails to read back: invalid charges or request ids become a retained contract failure", async () => {
    const dir = join(tempRoot("journal"), "j")
    const journal = new Journal(createJournalStore(dir), SCOPE)
    const outcomes = [
      { state: "completed", charges: [{ party: "platform", currency: "USD", amount: "1e-7", basis: "reported" }], costStatus: "known" },
      { state: "completed", charges: [], costStatus: "known", providerRequestId: "r".repeat(300) },
    ] as const
    for (const [index, outcome] of outcomes.entries()) {
      const record = await journal.reserve(draft(`bad-${index}`, "0.1", "s"), () => undefined)
      await journal.dispatch(record.id)
      const settled = await journal.settle(record.id, outcome as never)
      expect(settled).toMatchObject({ state: "failed", charges: [], costStatus: "unknown", reservation: { status: "retained" }, error: { code: "PROVIDER_CONTRACT_CHANGED" } })
      expect(settled.providerRequestId).toBeUndefined()
    }
    expect(await journal.list()).toHaveLength(2)
    expect(JournalDocument.safeParse(JSON.parse(readFileSync(join(dir, "journal.json"), "utf8"))).success).toBe(true)
  })

  test("one call is one operation: a reused intent is refused, and only the owner dispatches a planned record", async () => {
    const dir = join(tempRoot("journal"), "j")
    const journal = new Journal(createJournalStore(dir), SCOPE)
    const record = await journal.reserve(draft("intent-1", "0.1", "s"), () => undefined)
    expect((await failure(journal.reserve(draft("intent-1", "0.1", "s"), () => undefined))).message).toMatch(/^SUBMISSION_UNKNOWN: Operation op_.* already exists for this call/)
    await journal.dispatch(record.id)
    expect((await failure(journal.dispatch(record.id))).code).toBe("SUBMISSION_UNKNOWN")
    const settled = await journal.settle(record.id, { state: "completed", charges: [{ party: "platform", currency: "USD", amount: "0.03", basis: "reported" }, { party: "upstream", currency: "USD", amount: "0.02", basis: "reported" }], costStatus: "known" })
    // Platform and upstream are separate charges; both count, neither is folded into the other.
    expect(settled.charges.map((charge) => charge.party)).toEqual(["platform", "upstream"])
    expect(totals([settled])).toEqual({ committed: "0.05", reserved: "0", unknown: "0" })
    const credits = await journal.reserve(draft("intent-2", "0.1", "s"), () => undefined)
    await journal.dispatch(credits.id)
    const inCredits = await journal.settle(credits.id, { state: "completed", charges: [{ party: "platform", currency: "credits", amount: "3", basis: "reported" }], costStatus: "known" })
    // Credits are never added to dollars: the dollar reservation is retained.
    expect(inCredits.reservation.status).toBe("retained")
  })
})
