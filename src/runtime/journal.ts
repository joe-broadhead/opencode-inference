import { randomUUID } from "node:crypto"
import * as z from "zod"
import { Charge, Decimal, RouteRef } from "../domain/contracts.js"
import { InferenceError } from "../domain/errors.js"
import { format, type Money } from "../domain/money.js"

// The operation journal (handoff §10.1, §10.2, §11.2): a private persisted record of every billable operation, written
// BEFORE anything is sent. One journal per OpenRouter connection on this machine; each record carries its project, and
// the rolling budget spans every project using that connection here.
//
// States for synchronous operations:
//
//   planned ──▶ dispatching ──▶ completed
//      │             ├────────▶ failed
//      ▼             └────────▶ submission_unknown
//    failed (never sent: reservation released)
//
// - `planned` is written with its reservation inside the admission check; `dispatching` is persisted before the
//   transport is called. A record is never dispatched unless this process moved it from planned to dispatching itself.
// - `submission_unknown` keeps its reservation and is never resubmitted.
// - Concurrency: a process mutex serialises this process's transactions, and the store's exclusive lock file
//   serialises processes. The lock is held only for the read-modify-write, never across a network call. A lock that is
//   still held after a bounded wait is NEVER taken over on a timer: the call is refused with the owner's pid and
//   whether it is running, and the person removes the lock once they know no process is using it.
// - Recovery: inside a transaction, another process's `planned` record whose owner is confirmed not running becomes
//   `failed` and releases its reservation (it was never sent: dispatch needs the planned→dispatching step), and its
//   `dispatching` record becomes `submission_unknown` and keeps its reservation. An owner that may be alive is left alone.

export const OPERATION_STATES = ["planned", "dispatching", "completed", "failed", "submission_unknown"] as const
export type OperationState = (typeof OPERATION_STATES)[number]

const Owner = z.strictObject({ pid: z.number().int().positive(), host: z.string().regex(/^[0-9a-f]{16}$/), instance: z.string().uuid() })
export type Owner = z.infer<typeof Owner>

export const OperationRecord = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^op_[0-9a-f-]{36}$/),
  projectId: z.string().min(1).max(256),
  accountScope: z.string().regex(/^openrouter:[0-9a-f]{16}$/),
  /** The logical invocation: the tool call. Not the content hash: a deliberate second call is a new operation. */
  intentId: z.string().min(1).max(512),
  initiatedBy: z.strictObject({ sessionId: z.string().min(1).max(256), agentRef: z.string().max(256).optional() }),
  capability: z.string().max(64),
  route: RouteRef,
  sourceRefs: z.array(z.strictObject({ artifactId: z.string().max(128).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(64),
  constraintsDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  requestFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  state: z.enum(OPERATION_STATES),
  owner: Owner,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().optional(),
  settledAt: z.iso.datetime().optional(),
  providerRequestId: z.string().max(256).optional(),
  reservation: z.strictObject({
    amount: Decimal,
    currency: z.literal("USD"),
    basis: z.enum(["upper_bound", "admission_budget"]),
    /** held: in flight. retained: kept for an unknown cost. settled: replaced by the charges. released: never sent. */
    status: z.enum(["held", "retained", "settled", "released"]),
  }),
  charges: z.array(Charge).max(8),
  costStatus: z.enum(["known", "estimated", "unknown"]),
  /** A failure code only: never a message, a body or a URL. */
  error: z.strictObject({ code: z.string().regex(/^[A-Z_]{2,40}$/) }).optional(),
  attempts: z.array(z.strictObject({ kind: z.literal("submit"), at: z.iso.datetime(), result: z.string().regex(/^[a-z_]{2,40}$/) })).max(8),
  cancel: z.strictObject({ requested: z.boolean(), upstream: z.literal("unsupported") }),
})
export type OperationRecord = z.infer<typeof OperationRecord>

export const JournalDocument = z.strictObject({
  schemaVersion: z.literal(1),
  accountScope: z.string().regex(/^openrouter:[0-9a-f]{16}$/),
  records: z.array(OperationRecord).max(20_000),
})
export type JournalDocument = z.infer<typeof JournalDocument>

/** Where the lock is held and by whom, when it could not be taken. */
export class LockHeld extends Error {
  constructor(
    readonly lockPath: string,
    readonly owner: { readonly pid?: number; readonly liveness: "running" | "not_running" | "unknown" },
  ) {
    super("lock held")
    this.name = "LockHeld"
  }
}

/** The host's persistence: one exclusive transaction at a time across processes. Implemented in src/host/journal-store.ts. */
export interface JournalStore {
  /**
   * Takes the cross-process lock (refusing with LockHeld after a bounded wait, never taking it over), reads the
   * document (undefined when none exists), and writes `next` atomically and durably when `fn` returns one.
   */
  transact<T>(fn: (current: unknown) => { readonly next?: JournalDocument; readonly result: T }): Promise<T>
  /** This process. */
  readonly owner: Owner
  /** Whether another record's owner is running. `unknown` for another host or an unclear answer. */
  liveness(owner: Owner): "running" | "not_running" | "unknown"
}

/** A process mutex per journal: this process's transactions queue instead of contending for the lock file. */
const mutexes = new Map<JournalStore, Promise<unknown>>()
function serialised<T>(store: JournalStore, work: () => Promise<T>): Promise<T> {
  const previous = mutexes.get(store) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.catch(() => undefined)
  mutexes.set(store, tail)
  void tail.then(() => mutexes.get(store) === tail && mutexes.delete(store))
  return next
}

/** Terminal records older than this leave the journal; unsettled ones never do. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export interface Draft {
  readonly projectId: string
  readonly intentId: string
  readonly initiatedBy: OperationRecord["initiatedBy"]
  readonly capability: string
  readonly route: OperationRecord["route"]
  readonly sourceRefs: OperationRecord["sourceRefs"]
  readonly constraintsDigest: string
  readonly requestFingerprint: string
  readonly reservation: { readonly amount: Money; readonly basis: OperationRecord["reservation"]["basis"] }
}

/** How an operation ended, as the dispatcher knows it. */
export type Outcome =
  | { readonly state: "completed"; readonly charges: readonly z.infer<typeof Charge>[]; readonly costStatus: OperationRecord["costStatus"]; readonly providerRequestId?: string }
  | { readonly state: "failed"; readonly code: string; readonly sent: boolean; readonly charges?: readonly z.infer<typeof Charge>[]; readonly costStatus?: OperationRecord["costStatus"]; readonly providerRequestId?: string }
  | { readonly state: "submission_unknown"; readonly code: string }

export class Journal {
  constructor(
    private readonly store: JournalStore,
    readonly accountScope: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private transact<T>(fn: (records: OperationRecord[], at: string) => { changed: boolean; result: T }) {
    return serialised(this.store, async () => {
      try {
        return await this.store.transact((current) => {
          const document = this.parse(current)
          const at = this.now().toISOString()
          const recovered = this.recover(document.records, at)
          const { changed, result } = fn(document.records, at)
          const kept = this.prune(document.records)
          if (!(changed || recovered || kept)) return { result }
          // A write must never produce a journal that fails to read: check the whole document before it is written.
          if (!JournalDocument.safeParse(document).success) throw new InferenceError("JOURNAL_UNREADABLE", "The journal update was refused because it would not read back; nothing was written.")
          return { next: document, result }
        })
      } catch (error) {
        if (error instanceof InferenceError) throw error
        if (error instanceof LockHeld) {
          const who = error.owner.pid === undefined ? "an unknown process" : `process ${error.owner.pid}`
          const state = error.owner.liveness === "running" ? "which is running" : error.owner.liveness === "not_running" ? "which is not running" : "whose state is unknown"
          throw new InferenceError("JOURNAL_LOCKED", `The operation journal is locked by ${who}, ${state}; the lock is never taken over automatically. The lock file is ${error.lockPath}.`)
        }
        throw new InferenceError("JOURNAL_UNREADABLE")
      }
    })
  }

  private parse(current: unknown): JournalDocument {
    if (current === undefined) return { schemaVersion: 1, accountScope: this.accountScope, records: [] }
    const parsed = JournalDocument.safeParse(current)
    // A journal that does not parse is never reset: unsettled reservations would vanish with it.
    if (!parsed.success || parsed.data.accountScope !== this.accountScope) throw new InferenceError("JOURNAL_UNREADABLE", "The operation journal does not match its schema or its account.")
    return parsed.data
  }

  private recover(records: OperationRecord[], at: string) {
    let changed = false
    for (const record of records) {
      if (record.state !== "planned" && record.state !== "dispatching") continue
      if (record.owner.instance === this.store.owner.instance) continue
      if (this.store.liveness(record.owner) !== "not_running") continue
      changed = true
      record.updatedAt = at
      if (record.state === "planned") {
        record.state = "failed"
        record.error = { code: "RECOVERED_UNSENT" }
        record.reservation.status = "released"
      } else {
        record.state = "submission_unknown"
        record.error = { code: "RECOVERED_UNKNOWN" }
        record.reservation.status = "retained"
        record.costStatus = "unknown"
      }
    }
    return changed
  }

  private prune(records: OperationRecord[]) {
    const before = records.length
    const cutoff = this.now().getTime() - RETENTION_MS
    const keep = records.filter((record) => record.reservation.status === "held" || record.state === "submission_unknown" || Date.parse(record.updatedAt) >= cutoff)
    records.splice(0, records.length, ...keep)
    return records.length !== before
  }

  /**
   * Admission and the planned record, in one locked step: `admit` sees every record (this process's and others') and
   * throws to refuse. Returns the new record.
   */
  reserve(draft: Draft, admit: (records: readonly OperationRecord[]) => void): Promise<OperationRecord> {
    return this.transact((records, at) => {
      const existing = records.find((record) => record.intentId === draft.intentId)
      if (existing) throw new InferenceError("SUBMISSION_UNKNOWN", `Operation ${existing.id} already exists for this call.`)
      admit(records)
      const record: OperationRecord = {
        schemaVersion: 1,
        id: `op_${randomUUID()}`,
        projectId: draft.projectId,
        accountScope: this.accountScope,
        intentId: draft.intentId,
        initiatedBy: draft.initiatedBy,
        capability: draft.capability,
        route: draft.route,
        sourceRefs: draft.sourceRefs,
        constraintsDigest: draft.constraintsDigest,
        requestFingerprint: draft.requestFingerprint,
        state: "planned",
        owner: this.store.owner,
        createdAt: at,
        updatedAt: at,
        reservation: { amount: format(draft.reservation.amount), currency: "USD", basis: draft.reservation.basis, status: "held" },
        charges: [],
        costStatus: "unknown",
        attempts: [],
        cancel: { requested: false, upstream: "unsupported" },
      }
      records.push(OperationRecord.parse(record))
      return { changed: true, result: structuredClone(record) }
    })
  }

  /** planned → dispatching, persisted. Refuses unless this process still owns the planned record. */
  dispatch(id: string): Promise<void> {
    return this.transact((records, at) => {
      const record = records.find((item) => item.id === id)
      if (!record || record.state !== "planned" || record.owner.instance !== this.store.owner.instance)
        throw new InferenceError("SUBMISSION_UNKNOWN", `Operation ${id} is no longer planned by this process, so it was not sent.`)
      record.state = "dispatching"
      record.dispatchedAt = at
      record.updatedAt = at
      record.attempts.push({ kind: "submit", at, result: "dispatching" })
      return { changed: true, result: undefined }
    })
  }

  /** Records how the operation ended and what it counts against the budgets. */
  settle(id: string, outcome: Outcome): Promise<OperationRecord> {
    return this.transact((records, at) => {
      const record = records.find((item) => item.id === id)
      if (!record) throw new InferenceError("JOURNAL_UNREADABLE", `Operation ${id} is missing from the journal.`)
      // A late answer to an operation recovered as submission_unknown still settles it, but only for its owner.
      const open = record.state === "planned" || record.state === "dispatching" || (record.state === "submission_unknown" && record.owner.instance === this.store.owner.instance)
      if (!open) return { changed: false, result: structuredClone(record) }
      const settled = this.settled(structuredClone(record), outcome, at)
      // What the outcome carried (charges, a request id) must fit the record's schema. If it does not, the record is
      // kept as a contract failure with its reservation retained, without the offending values.
      const checked = OperationRecord.safeParse(settled)
      const next = checked.success
        ? checked.data
        : OperationRecord.parse(this.settled(structuredClone(record), { state: "failed", code: "PROVIDER_CONTRACT_CHANGED", sent: true }, at))
      records[records.indexOf(record)] = next
      return { changed: true, result: structuredClone(next) }
    })
  }

  private settled(record: OperationRecord, outcome: Outcome, at: string): OperationRecord {
    // Applies `outcome` to a copy of the record; the caller checks the copy against the schema before keeping it.
    record.updatedAt = at
    record.settledAt = at
    const last = record.attempts.at(-1)
    if (last) last.result = outcome.state
    if (outcome.state === "submission_unknown") {
      record.state = "submission_unknown"
      record.error = { code: outcome.code }
      record.reservation.status = "retained"
      record.costStatus = "unknown"
    } else {
      record.state = outcome.state
      if (outcome.providerRequestId) record.providerRequestId = outcome.providerRequestId
      if (outcome.state === "failed") record.error = { code: outcome.code }
      const charges = outcome.charges ?? []
      const costStatus = outcome.costStatus ?? (outcome.state === "failed" && !outcome.sent ? "known" : "unknown")
      record.charges = [...charges]
      record.costStatus = costStatus
      // Never sent: nothing to pay. Cost known and reported in USD: the charges count. Anything else keeps the
      // reservation, because failure does not mean zero cost and credits are never added to dollars.
      const reported = costStatus === "known" && charges.every((charge) => charge.currency === "USD" && charge.basis === "reported")
      record.reservation.status = outcome.state === "failed" && !outcome.sent ? "released" : reported ? "settled" : "retained"
    }
    return record
  }

  /** Every record, for status and tests. */
  list(): Promise<OperationRecord[]> {
    return this.transact((records) => ({ changed: false, result: structuredClone(records) }))
  }
}
