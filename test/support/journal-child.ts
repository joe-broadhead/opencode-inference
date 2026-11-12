// A separate process using the real journal store, for test/unit/journal.test.ts. Modes:
//   reserve <dir> <count> <amount> <session> <sessionUsd> <startAt>: from startAt (epoch ms), try `count` reservations
//     of `amount` against one session budget, dispatching each one admitted; prints { admitted, refused }.
//   crash-planned <dir> / crash-dispatching <dir>: reserve (and dispatch), then exit without settling, as a crash.
import { InferenceError } from "../../src/domain/errors.js"
import { money } from "../../src/domain/money.js"
import { createJournalStore } from "../../src/host/journal-store.js"
import { admit } from "../../src/runtime/budget.js"
import { Journal, type Draft } from "../../src/runtime/journal.js"

export const SCOPE = "openrouter:00000000000000aa"
const SHA = "0".repeat(64)

export const draft = (intent: string, amount: string, session: string): Draft => ({
  projectId: "prj_test",
  intentId: intent,
  initiatedBy: { sessionId: session },
  capability: "probe",
  route: { provider: "openrouter", model: "test/probe", apiRoute: "POST /api/alpha/extractions", endpointProfile: "test", capabilityRevision: "test-1" },
  sourceRefs: [{ sha256: SHA }],
  constraintsDigest: `sha256:${SHA}`,
  requestFingerprint: `sha256:${SHA}`,
  reservation: { amount: money(amount), basis: "upper_bound" },
})

export const limits = (sessionUsd: string) => ({ requestUsd: "1", sessionUsd, rolling24hUsd: "1000", requirePricedRoute: true, requireUpperBound: false })

if (import.meta.main) {
  const [mode, dir, ...rest] = process.argv.slice(2)
  const journal = new Journal(createJournalStore(dir!, { lockWaitMs: 20_000 }), SCOPE)
  if (mode === "reserve") {
    const [count, amount, session, sessionUsd, startAt] = rest
    while (Date.now() < Number(startAt)) await new Promise((resolve) => setTimeout(resolve, 1))
    let admitted = 0
    let refused = 0
    for (let index = 0; index < Number(count); index++) {
      try {
        const record = await journal.reserve(draft(`${process.pid}:${index}`, amount!, session!), (records) => admit(records, { sessionId: session!, amount: money(amount!) }, limits(sessionUsd!), new Date()))
        // Dispatched and never settled, so a record outlives this process with its reservation (a planned record of an
        // exited process would rightly be released by the other process's recovery).
        await journal.dispatch(record.id)
        admitted++
      } catch (error) {
        if (!(error instanceof InferenceError) || error.code !== "BUDGET_EXCEEDED") throw error
        refused++
      }
    }
    console.log(JSON.stringify({ admitted, refused }))
  } else if (mode === "crash-planned" || mode === "crash-dispatching") {
    const record = await journal.reserve(draft(`crash:${process.pid}`, "0.25", "ses_crash"), () => undefined)
    if (mode === "crash-dispatching") await journal.dispatch(record.id)
    console.log(JSON.stringify({ id: record.id }))
    process.exit(0)
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
}
