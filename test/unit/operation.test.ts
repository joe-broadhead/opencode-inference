// The operation pipeline (handoff §7, §11, §17.1 PR 2 rows), with a test-only "probe" operation and a fake transport,
// through the real dispatcher on BOTH host surfaces: the model's tool (as the host's tool editor registers it) and the
// tools RPC (the family's shared module, with its ask-refusing hook). Every test runs under the network spy.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync, appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { TransportError } from "../../src/providers/openrouter/http.js"
import { InferenceError } from "../../src/domain/errors.js"
import { spyNetwork } from "../support/network-spy.js"
import { pathInput, probeAdapter, probeHarness, probeRoute, textInput } from "../support/operation-kit.js"
import { tempRoot } from "../support/temp.js"

let network: ReturnType<typeof spyNetwork>
const logged: unknown[][] = []
const consoleMethods = ["log", "info", "warn", "error", "debug"] as const
const originals = consoleMethods.map((name) => console[name])
beforeEach(() => {
  network = spyNetwork()
  logged.length = 0
  for (const name of consoleMethods) console[name] = (...args: unknown[]) => void logged.push(args)
})
afterEach(() => {
  network.restore()
  consoleMethods.forEach((name, index) => (console[name] = originals[index]!))
  expect(network.calls).toEqual([])
})

const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    return error as Error & { _tag?: string; metadata?: { code?: string } }
  }
  throw new Error("expected a failure")
}
/** An RPC failure as a script reads it. */
const rpcError = (value: unknown) => (value as { error: { message: string; data: { code: string } } }).error
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

describe("the happy path on both surfaces", () => {
  test("text: one reservation, one dispatch, settled with the reported charge, and the same structured result", async () => {
    const harness = await probeHarness()
    const model = (await harness.model(textInput())) as { output: Record<string, unknown>; content: string }
    expect(model.output).toMatchObject({ schemaVersion: 1, data: { fields: { title: "x" } }, route: { model: "test/probe", capabilityRevision: "test-fixture-1" }, trust: "untrusted" })
    expect(model.output.usage).toEqual({ charges: [{ party: "platform", currency: "USD", amount: "0.004", basis: "reported" }], costStatus: "known" })
    const script = (await harness.rpc(textInput())) as Record<string, unknown>
    expect(script).toMatchObject({ schemaVersion: 1, data: { fields: { title: "x" } }, review: { required: true } })
    expect(harness.sent).toHaveLength(2)
    expect(harness.sent[0]!.path).toBe("/api/alpha/extractions")
    const records = await harness.journal.list()
    expect(records.map((record) => [record.state, record.reservation.status, record.reservation.amount, record.capability])).toEqual([
      ["completed", "settled", "0.01", "probe"],
      ["completed", "settled", "0.01", "probe"],
    ])
    expect(records[0]!.sourceRefs).toEqual([{ sha256: sha("Invoice AB-72. Total EUR 120.00.") }])
    expect(records[0]!.attempts).toEqual([{ kind: "submit", at: expect.any(String), result: "completed" }])
    // No file source: nothing to assert beyond the tool action, which the host owns.
    expect(harness.fake.asserted).toEqual([])
  })

  test("a path inside the project: read is asserted on the host's own relative resource, then the bytes are snapshotted", async () => {
    const harness = await probeHarness()
    writeFileSync(join(harness.project, "note.txt"), "Hello there")
    await harness.model(pathInput("note.txt"))
    expect(harness.fake.asserted.map((item) => [item.action, item.resources])).toEqual([["read", ["note.txt"]]])
    expect(harness.counts.read).toBe(1)
    const [record] = await harness.journal.list()
    expect(record!.sourceRefs).toEqual([{ sha256: sha("Hello there") }])
  })

  test("a path outside the project also asserts external_directory, first", async () => {
    const harness = await probeHarness()
    mkdirSync(join(harness.root, "outside"))
    writeFileSync(join(harness.root, "outside", "a.txt"), "outside text")
    await harness.model(pathInput(join(harness.root, "outside", "a.txt")))
    expect(harness.fake.asserted.map((item) => item.action)).toEqual(["external_directory", "read"])
    expect(harness.fake.asserted[0]!.resources).toEqual([`${join(harness.root, "outside")}/*`])
  })

  test("outside the project, a linked folder is asked for, and read from, by its real path, never the link path", async () => {
    const outside = join(tempRoot("outside"), "x")
    mkdirSync(join(outside, "realdir"), { recursive: true })
    writeFileSync(join(outside, "realdir", "secret.txt"), "the real folder's file")
    symlinkSync(join(outside, "realdir"), join(outside, "extdir"))
    const harness = await probeHarness()
    await harness.model(pathInput(join(outside, "extdir", "secret.txt")))
    expect(harness.fake.asserted.map((item) => [item.action, item.resources])).toEqual([
      ["external_directory", [`${join(outside, "realdir")}/*`]],
      ["read", [join(outside, "realdir", "secret.txt")]],
    ])
    // An agent that allows the link's folder but denies the real one reads nothing.
    const guarded = await probeHarness({
      agentRules: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: `${join(outside, "realdir")}/*`, effect: "deny" },
        { action: "external_directory", resource: `${join(outside, "extdir")}/*`, effect: "allow" },
      ],
    })
    expect((await failure(guarded.model(pathInput(join(outside, "extdir", "secret.txt"))))).message).toBe("Permission denied: external_directory")
    expect(guarded.counts.read).toBe(0)
    expect(guarded.sent).toEqual([])
  })

  test("an image is typed by its bytes and sent as a snapshot", async () => {
    const harness = await probeHarness()
    writeFileSync(join(harness.project, "pic.png"), PNG)
    await harness.model(pathInput("pic.png"))
    const body = JSON.parse(new TextDecoder().decode(harness.sent[0]!.body)) as { input: { sha256: string } }
    expect(body.input.sha256).toBe(sha(PNG))
  })
})

describe("authorization", () => {
  const denyRead = [{ action: "*", resource: "*", effect: "allow" as const }, { action: "read", resource: "*", effect: "deny" as const }]

  test("a denied file read, on the model path and the tools RPC: no byte read, no reservation, nothing sent", async () => {
    const harness = await probeHarness({ agentRules: denyRead })
    writeFileSync(join(harness.project, "secret.txt"), "do not read")
    const error = await failure(harness.model(pathInput("secret.txt")))
    // The host's permission error propagates unchanged.
    expect(error._tag).toBe("Tool.Error")
    expect(error.message).toBe("Permission denied: read")
    const script = rpcError(await harness.rpc(pathInput("secret.txt")))
    expect(script.data.code).toBe("PERMISSION_DENIED")
    expect(harness.counts.read).toBe(0)
    expect(harness.sent).toEqual([])
    expect(await harness.journal.list()).toEqual([])
  })

  test("a script whose agent denies or would be asked for the tool itself is refused before the dispatcher runs", async () => {
    for (const effect of ["deny", "ask"] as const) {
      const harness = await probeHarness({ agentRules: [{ action: "*", resource: "*", effect: "allow" }, { action: "inference_probe", resource: "*", effect }] })
      writeFileSync(join(harness.project, "a.txt"), "text")
      expect(rpcError(await harness.rpc(pathInput("a.txt"))).data.code).toBe("PERMISSION_DENIED")
      expect(harness.counts.inspect + harness.counts.read).toBe(0)
      expect(harness.sent).toEqual([])
    }
  })

  test("ask refuses unattended: a script's file-read ask becomes a deny, no one is prompted, nothing is read", async () => {
    let prompted = 0
    const harness = await probeHarness({ agentRules: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "ask" }], onAsk: async () => (prompted++, "once") })
    writeFileSync(join(harness.project, "a.txt"), "text")
    const script = rpcError(await harness.rpc(pathInput("a.txt")))
    expect(script.data.code).toBe("PERMISSION_DENIED")
    expect(prompted).toBe(0)
    expect(harness.counts.read).toBe(0)
    expect(harness.sent).toEqual([])
    // The same ask on the model path is a prompt, and an approval runs.
    await harness.model(pathInput("a.txt"))
    expect(prompted).toBe(1)
    expect(harness.sent).toHaveLength(1)
  })

  test("a late approval after cancellation starts nothing", async () => {
    let approve!: () => void
    const controller = new AbortController()
    const harness = await probeHarness({
      agentRules: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "ask" }],
      onAsk: () =>
        new Promise((resolve) => {
          approve = () => resolve("once")
          controller.abort()
        }),
    })
    writeFileSync(join(harness.project, "a.txt"), "text")
    const error = await failure(harness.model(pathInput("a.txt"), controller.signal))
    expect(error.message).toMatch(/^CANCELLED:/)
    approve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.counts.read).toBe(0)
    expect(harness.sent).toEqual([])
    expect(await harness.journal.list()).toEqual([])
  })

  test("no key connected, or one that needs sign-in: refused before any file is touched or anyone is asked", async () => {
    for (const [account, code] of [[undefined, "AUTH_REQUIRED"], ["needs_auth", "AUTH_REJECTED"]] as const) {
      const harness = await probeHarness({ account })
      writeFileSync(join(harness.project, "a.txt"), "text")
      expect((await failure(harness.model(pathInput("a.txt")))).message).toMatch(new RegExp(`^${code}:`))
      expect(harness.counts.inspect + harness.counts.read).toBe(0)
      expect(harness.fake.asserted).toEqual([])
    }
  })

  test("availability is re-checked at execution: a module turned off, or a tool withdrawn after discovery, is refused", async () => {
    let open = true
    const harness = await probeHarness({ available: () => (open ? undefined : new InferenceError("MODULE_DISABLED")) })
    await harness.model(textInput())
    open = false
    expect((await failure(harness.model(textInput()))).message).toMatch(/^MODULE_DISABLED:/)
    expect(rpcError(await harness.rpc(textInput())).data.code).toBe("MODULE_DISABLED")
    expect(harness.sent).toHaveLength(1)
    const off = await probeHarness({ options: { modules: { extractions: false } } })
    expect((await failure(off.model(textInput()))).message).toMatch(/^MODULE_DISABLED:/)
    expect(off.sent).toEqual([])
  })
})

describe("source integrity", () => {
  test("a path replaced between approval and reading is refused", async () => {
    let harness!: Awaited<ReturnType<typeof probeHarness>>
    harness = await probeHarness({
      agentRules: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "ask" }],
      onAsk: async () => {
        // While the person looks at the prompt, the approved path is swapped for another file.
        writeFileSync(join(harness.project, "swap.txt"), "something else entirely")
        renameSync(join(harness.project, "swap.txt"), join(harness.project, "a.txt"))
        return "once"
      },
    })
    writeFileSync(join(harness.project, "a.txt"), "the approved text")
    expect((await failure(harness.model(pathInput("a.txt")))).message).toMatch(/^SOURCE_CHANGED:/)
    expect(harness.sent).toEqual([])
    expect(await harness.journal.list()).toEqual([])
  })

  test("a file changed in place after approval is refused", async () => {
    let harness!: Awaited<ReturnType<typeof probeHarness>>
    harness = await probeHarness({
      agentRules: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*", effect: "ask" }],
      onAsk: async () => (appendFileSync(join(harness.project, "a.txt"), " and more"), "once"),
    })
    writeFileSync(join(harness.project, "a.txt"), "the approved text")
    expect((await failure(harness.model(pathInput("a.txt")))).message).toMatch(/^SOURCE_CHANGED:/)
    expect(harness.sent).toEqual([])
  })

  test("symbolic links inside the project, '..' and non-files are refused before anyone is asked", async () => {
    const harness = await probeHarness()
    writeFileSync(join(harness.project, "real.txt"), "text")
    symlinkSync(join(harness.project, "real.txt"), join(harness.project, "link.txt"))
    mkdirSync(join(harness.project, "dir"))
    writeFileSync(join(harness.project, "dir", "inner.txt"), "text")
    symlinkSync(join(harness.project, "dir"), join(harness.project, "dirlink"))
    for (const path of ["link.txt", "dirlink/inner.txt", "dir/../real.txt", "dir", "missing.txt"])
      expect((await failure(harness.model(pathInput(path)))).message).toMatch(/^UNSAFE_PATH:/)
    expect(harness.fake.asserted).toEqual([])
    expect(harness.counts.read).toBe(0)
    expect(harness.sent).toEqual([])
  })

  test("oversized sources are refused without reading the file", async () => {
    const harness = await probeHarness()
    writeFileSync(join(harness.project, "big.txt"), "a".repeat(70 * 1024))
    expect((await failure(harness.model(pathInput("big.txt")))).message).toMatch(/^SOURCE_LIMIT:/)
    expect(harness.counts.read).toBe(0)
    writeFileSync(join(harness.project, "big.png"), Uint8Array.from([...PNG, ...new Uint8Array(5 * 1024)]))
    expect((await failure(harness.model(pathInput("big.png")))).message).toMatch(/^SOURCE_LIMIT:/)
    expect((await failure(harness.model(textInput("b".repeat(65 * 1024))))).message).toMatch(/^SOURCE_LIMIT:/)
    expect(harness.sent).toEqual([])
  })

  test("the type comes from the bytes: binary, a name that lies, and a type the route does not take are refused", async () => {
    const harness = await probeHarness()
    writeFileSync(join(harness.project, "blob.txt"), Uint8Array.from([0, 1, 2, 3, 255, 254]))
    writeFileSync(join(harness.project, "fake.png"), "plain text named like an image")
    writeFileSync(join(harness.project, "doc.txt"), "%PDF-1.7\n...")
    writeFileSync(join(harness.project, "anim.gif"), "GIF89a....")
    writeFileSync(join(harness.project, "noext"), "GIF89a....")
    for (const path of ["blob.txt", "fake.png", "doc.txt", "noext"]) expect((await failure(harness.model(pathInput(path)))).message).toMatch(/^SOURCE_TYPE:/)
    // A name the route cannot take fails at route resolution, before the file is opened.
    writeFileSync(join(harness.project, "doc.pdf"), "%PDF-1.7\n...")
    expect((await failure(harness.model(pathInput("doc.pdf")))).message).toMatch(/^CAPABILITY_UNSUPPORTED:/)
    expect(harness.sent).toEqual([])
    expect(await harness.journal.list()).toEqual([])
  })

  test("artifacts: a foreign project is refused unread; a hash that no longer matches is refused; a matching one runs", async () => {
    const harness = await probeHarness()
    const path = join(harness.project, "art.txt")
    writeFileSync(path, "artifact text")
    const artifact = (overrides: Record<string, unknown> = {}) => ({
      profile: "probe",
      fields: { title: { type: "text" } },
      source: {
        kind: "artifact",
        artifact: {
          schemaVersion: 1,
          id: "art_1",
          ownerPluginId: "media.core",
          projectId: "prj_fake",
          kind: "text",
          mimeType: "text/plain",
          bytes: 13,
          sha256: sha("artifact text"),
          locator: { kind: "local", path },
          createdAt: "2026-11-01T00:00:00Z",
          origin: { kind: "imported", parentIds: [] },
          trust: "untrusted",
          ...overrides,
        },
      },
    })
    expect((await failure(harness.model(artifact({ projectId: "prj_other" })))).message).toMatch(/^UNSAFE_PATH: The artifact belongs to another project/)
    expect((await failure(harness.model(artifact({ expiresAt: "2026-01-01T00:00:00Z" })))).message).toMatch(/^SOURCE_CHANGED: The artifact has expired/)
    expect(harness.fake.asserted).toEqual([])
    expect((await failure(harness.model(artifact({ sha256: sha("other") })))).message).toMatch(/^SOURCE_CHANGED:/)
    expect((await failure(harness.model(artifact({ bytes: 99 })))).message).toMatch(/^SOURCE_CHANGED:/)
    expect(harness.sent).toEqual([])
    await harness.model(artifact())
    expect((await harness.journal.list())[0]!.sourceRefs).toEqual([{ artifactId: "art_1", sha256: sha("artifact text") }])
  })

  test("bundles are refused for now", async () => {
    const harness = await probeHarness()
    const input = { profile: "probe", fields: { title: { type: "text" } }, source: { kind: "bundle", items: [{ key: "a", role: "text", source: { kind: "text", text: "x" } }] } }
    expect((await failure(harness.model(input))).message).toMatch(/^CAPABILITY_UNSUPPORTED:/)
  })
})

describe("spend and the journal", () => {
  test("requirePricedRoute refuses an unpriced route before any file is touched; requireUpperBound refuses an estimate before reserving", async () => {
    const unpriced = await probeHarness({ route: probeRoute({ pricing: null }) })
    writeFileSync(join(unpriced.project, "a.txt"), "text")
    expect((await failure(unpriced.model(pathInput("a.txt")))).message).toMatch(/^PRICE_UNKNOWN:/)
    expect(unpriced.counts.inspect).toBe(0)
    const strict = await probeHarness({ options: { spend: { requireUpperBound: true } }, adapter: probeAdapter(() => ({ kind: "estimate", amount: "0.001" })) })
    expect((await failure(strict.model(textInput()))).message).toMatch(/^PRICE_UNKNOWN:/)
    expect(await strict.journal.list()).toEqual([])
    expect(strict.sent).toEqual([])
  })

  test("an estimate is not a cap: it reserves the whole per-request budget; a tool input can only lower that budget", async () => {
    const harness = await probeHarness({ adapter: probeAdapter(() => ({ kind: "estimate", amount: "0.001" })) })
    await harness.model(textInput())
    expect((await harness.journal.list())[0]!.reservation).toMatchObject({ amount: "0.05", basis: "admission_budget" })
    await harness.model({ ...textInput(), limits: { maxEstimatedCostUsd: "0.002" } })
    expect((await harness.journal.list())[1]!.reservation).toMatchObject({ amount: "0.002" })
    expect((await failure(harness.model({ ...textInput(), limits: { maxEstimatedCostUsd: "0.0005" } }))).message).toMatch(/^BUDGET_EXCEEDED:/)
    expect(harness.sent).toHaveLength(2)
  })

  test("the session budget counts settled charges and held or retained reservations", async () => {
    const harness = await probeHarness({ options: { spend: { sessionUsd: "0.015" } } })
    await harness.model(textInput())
    await harness.model(textInput())
    expect((await failure(harness.model(textInput()))).message).toMatch(/^BUDGET_EXCEEDED: .*session budget of USD 0\.015/)
    expect(harness.sent).toHaveLength(2)
  })

  test("an ambiguous dispatch persists submission_unknown, keeps its reservation, and the reservation still counts", async () => {
    const harness = await probeHarness({ options: { spend: { sessionUsd: "0.015" } } })
    harness.replies.push(new TransportError("ambiguous", true))
    const error = await failure(harness.model(textInput()))
    expect(error.message).toMatch(/^SUBMISSION_UNKNOWN: .*op_[0-9a-f-]{36} keeps its reservation\. Next step: Reconcile the existing operation; do not resubmit\.$/)
    const [record] = await harness.journal.list()
    expect(record).toMatchObject({ state: "submission_unknown", costStatus: "unknown", reservation: { status: "retained", amount: "0.01" }, error: { code: "SUBMISSION_UNKNOWN" } })
    expect((await failure(harness.model(textInput()))).message).toMatch(/^BUDGET_EXCEEDED:/)
    expect(harness.sent).toHaveLength(1)
  })

  test("a deadline or a cancellation after sending is submission_unknown; a connection never opened releases", async () => {
    const harness = await probeHarness()
    harness.replies.push(new TransportError("timeout", true), new TransportError("not_sent", false), new TransportError("redirect", true), new TransportError("response_too_large", true))
    expect((await failure(harness.model(textInput()))).message).toMatch(/^DEADLINE_EXCEEDED:/)
    expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_ERROR: OpenRouter could not be reached; nothing was sent\./)
    expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_CONTRACT_CHANGED: OpenRouter answered with a redirect/)
    expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_CONTRACT_CHANGED: .*response cap/)
    const controller = new AbortController()
    harness.replies.push(async () => {
      controller.abort()
      throw new TransportError("cancelled", true)
    })
    expect((await failure(harness.model(textInput(), controller.signal))).message).toMatch(/^CANCELLED: The call was cancelled after the request may have reached OpenRouter/)
    const records = await harness.journal.list()
    expect(records.map((record) => [record.state, record.reservation.status, record.error?.code])).toEqual([
      ["submission_unknown", "retained", "DEADLINE_EXCEEDED"],
      ["failed", "released", "PROVIDER_ERROR"],
      ["failed", "retained", "PROVIDER_CONTRACT_CHANGED"],
      ["failed", "retained", "PROVIDER_CONTRACT_CHANGED"],
      ["submission_unknown", "retained", "CANCELLED"],
    ])
  })

  test("error answers: 401 costs nothing and says reconnect; 500 and a malformed 200 keep the reservation", async () => {
    const harness = await probeHarness()
    harness.replies.push(harness.ok({ error: "no" }, 401), harness.ok({ error: "boom" }, 500), harness.ok({ unexpected: true }))
    expect((await failure(harness.model(textInput()))).message).toMatch(/^AUTH_REJECTED:/)
    expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_ERROR: OpenRouter answered with HTTP 500\. Operation op_.* keeps its reservation/)
    expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_CONTRACT_CHANGED:/)
    const records = await harness.journal.list()
    expect(records.map((record) => [record.state, record.reservation.status, record.costStatus])).toEqual([
      ["failed", "settled", "known"],
      ["failed", "retained", "unknown"],
      ["failed", "retained", "unknown"],
    ])
  })

  test("adapter usage or a request id outside the contract is refused before settling, and the journal stays readable", async () => {
    const bad = [
      { charges: [{ party: "platform", currency: "USD", amount: "1e-7", basis: "reported" }], costStatus: "known" },
      { charges: [{ party: "platform", currency: "USD", amount: "0.001", basis: "reported" }], costStatus: "known", providerRequestId: "r".repeat(300) },
    ]
    for (const usage of bad) {
      const base = probeAdapter()
      const { providerRequestId, ...rest } = usage as typeof usage & { providerRequestId?: string }
      const adapter = { ...base, parse: (...args: Parameters<typeof base.parse>) => ({ ...base.parse(...args), usage: rest as never, ...(providerRequestId ? { providerRequestId } : {}) }) }
      const harness = await probeHarness({ adapter })
      expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_CONTRACT_CHANGED: The adapter reported usage or a request id outside the contract\. Operation op_.* keeps its reservation/)
      const [record] = await harness.journal.list()
      expect(record).toMatchObject({ state: "failed", reservation: { status: "retained" }, error: { code: "PROVIDER_CONTRACT_CHANGED" }, charges: [] })
      expect(record!.providerRequestId).toBe("req_probe")
      // The next billable call on the same connection still reaches the journal and the transport: it is not refused as
      // JOURNAL_UNREADABLE.
      expect((await failure(harness.model(textInput()))).message).toMatch(/^PROVIDER_CONTRACT_CHANGED:/)
      expect(harness.sent).toHaveLength(2)
      expect(await harness.journal.list()).toHaveLength(2)
    }
  })

  test("limits.concurrency queues requests in this process", async () => {
    const harness = await probeHarness({ options: { limits: { concurrency: 1 } } })
    let finish!: () => void
    harness.replies.push(() => new Promise((resolve) => (finish = () => resolve(harness.ok({ fields: {}, cost: "0" })))))
    const first = harness.model(textInput())
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = harness.model(textInput())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.sent).toHaveLength(1)
    finish()
    await Promise.all([first, second])
    expect(harness.sent).toHaveLength(2)
  })
})

describe("secrets and payloads", () => {
  test("source text never reaches an error, the journal, the tool text or a log", async () => {
    const marker = "SOURCE-TEXT-MARKER-4417"
    const harness = await probeHarness()
    harness.replies.push(new TransportError("ambiguous", true), harness.ok({ unexpected: marker }))
    const messages = [(await failure(harness.model(textInput(marker)))).message, (await failure(harness.model(textInput(marker)))).message]
    const ok = (await harness.model(textInput(marker))) as { content: string }
    expect(harness.sent[0]!.body.byteLength).toBeGreaterThan(0)
    const journalFile = readFileSync(join(harness.state, "journal", "journal.json"), "utf8")
    for (const text of [...messages, ok.content, journalFile, JSON.stringify(logged)]) expect(text).not.toContain(marker)
    expect(logged).toEqual([])
    expect(existsSync(join(harness.state, "journal", "journal.lock"))).toBe(false)
  })
})
