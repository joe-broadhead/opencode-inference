// A test-only operation for the PR 2 pipeline: a fake "probe" tool (class send, operation extract) with a fake
// adapter and a fake transport, run through the real dispatcher, the real host projections (model tools and tools
// RPC), the real host file access, the real journal store and createAuthorize over a host-like fake assert. Nothing in
// it reaches a network: the transport is a recorder.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import * as z from "zod"
import { loadConfig, type Options } from "../../src/domain/config.js"
import { ExtractInput, InferenceResult } from "../../src/domain/contracts.js"
import { InferenceError } from "../../src/domain/errors.js"
import type { ToolSpec } from "../../src/domain/registry.js"
import { files as hostFiles } from "../../src/host/files.js"
import { createJournalStore } from "../../src/host/journal-store.js"
import { createAuthorize } from "../../src/host/permissions.js"
import { registerScripting } from "../../src/host/scripting.js"
import { toolTransform } from "../../src/host/tools.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { OPENROUTER_CAPABILITIES, type CapabilityFixture, type RouteCapability } from "../../src/providers/openrouter/capabilities.js"
import { TransportError, type Account, type Transport, type TransportRequest, type TransportResponse } from "../../src/providers/openrouter/http.js"
import { createDispatcher } from "../../src/runtime/dispatch.js"
import { Journal } from "../../src/runtime/journal.js"
import type { Adapter } from "../../src/runtime/operation.js"
import type { FileAccess } from "../../src/runtime/sources.js"
import { fakeContext, type AssertRequest } from "./fake-context.js"
import { tempRoot } from "./temp.js"

export const PROBE_MODEL = "test/probe"
const KiB = 1024

export const probeRoute = (overrides: Partial<RouteCapability> = {}): RouteCapability => ({
  id: "openrouter:extract:test/probe",
  provider: "openrouter",
  operation: "extract",
  model: PROBE_MODEL,
  canonicalSlug: null,
  apiRoute: "POST /api/alpha/extractions",
  endpointProfile: "test-probe",
  status: "documented",
  enabled: true,
  inputs: { text: true, images: { maxCount: 1, maxBytesEach: 4 * KiB, maxBytesTotal: 4 * KiB, mimeTypes: ["image/png"], ordered: true }, pdf: null, textWithDocument: null },
  maxRequestBytes: 64 * KiB,
  effectiveContextTokens: null,
  contextAllowance: null,
  fieldTypes: ["text"],
  listItemTypes: [],
  questionTypes: [],
  nullThreshold: { supported: true, unsupportedOn: [] },
  pricing: { revision: "test-1", currency: "USD", perRequest: "0.01", upperBound: true },
  zdr: "unknown",
  // Test routes stand for verified ones.
  canary: { status: "passed", on: "2026-11-12" },
  notes: [],
  ...overrides,
})

export const probeFixture = (route = probeRoute()): CapabilityFixture => ({ ...OPENROUTER_CAPABILITIES, revision: "test-fixture-1", routes: [route] })

export const ProbeData = z.strictObject({ fields: z.record(z.string(), z.string().nullable()) })

/** The test-only operation. Registered nowhere but in these tests. */
export const PROBE: ToolSpec = {
  name: "probe",
  class: "send",
  operation: "extract",
  module: "extractions",
  effects: { network: true, uploadsSource: true, billable: true, readsFiles: true },
  description: "A test-only operation.",
  input: ExtractInput,
  output: InferenceResult(ProbeData),
}

/** The fake adapter: the quote is the route's fixed price, the request is JSON, the answer is { fields, cost }. */
export const probeAdapter = (quote: () => ReturnType<Adapter["quote"]> = () => ({ kind: "upper_bound", amount: "0.01" })): Adapter => ({
  operation: "extract",
  revision: "probe-adapter-1",
  quote,
  request: (input, source) => {
    const fields = Object.keys((input as { fields: Record<string, unknown> }).fields)
    const body = { model: PROBE_MODEL, fields, input: source.modality === "text" ? { text: source.text() } : { bytes: source.bytes, sha256: source.sha256 } }
    return { path: "/api/alpha/extractions", body: new TextEncoder().encode(JSON.stringify(body)) }
  },
  parse: (response, { source }) => {
    let answer: { fields?: unknown; cost?: unknown }
    try {
      answer = JSON.parse(new TextDecoder().decode(response.body)) as typeof answer
    } catch {
      throw new InferenceError("PROVIDER_CONTRACT_CHANGED", "The answer is not JSON.")
    }
    const fields = ProbeData.shape.fields.safeParse(answer.fields)
    if (!fields.success || typeof answer.cost !== "string") throw new InferenceError("PROVIDER_CONTRACT_CHANGED", "The answer does not match the probe contract.")
    return {
      data: { fields: fields.data },
      usage: { charges: [{ party: "platform", currency: "USD", amount: answer.cost, basis: "reported" }], costStatus: "known" },
      coverage: { status: source.modality === "text" ? "complete" : "unknown", basis: "provided-text", sourceTruncated: false, warnings: [] },
      review: { required: true, reasons: ["CALIBRATION_UNAVAILABLE"], profileVersion: "review-first-v1" },
    }
  },
})

export type Reply = TransportResponse | TransportError | ((request: TransportRequest) => Promise<TransportResponse>)

/** A recording transport. Each `post` takes the next reply. */
export const ACCOUNT: Account = { scope: "openrouter:0123456789abcdef", connection: { type: "credential", id: "cred_test", label: "test", method: "key" } as never }

export function fakeTransport(account: Account | "needs_auth" | undefined) {
  const sent: TransportRequest[] = []
  const replies: Reply[] = []
  const ok = (body: unknown, status = 200): TransportResponse => ({ status, contentType: "application/json", requestId: "req_probe", body: new TextEncoder().encode(JSON.stringify(body)), elapsedMs: 3 })
  const transport: Transport = {
    account: async () => account,
    post: async (request) => {
      sent.push(request)
      const reply = replies.shift() ?? ok({ fields: { title: "x" }, cost: "0.004" })
      if (reply instanceof TransportError) throw reply
      if (typeof reply === "function") return reply(request)
      return reply
    },
  }
  return { transport, sent, replies, ok }
}

/** Host file access with a count of descriptor reads, so a test can prove no byte was read. */
export function countingFiles(base: FileAccess = hostFiles) {
  const counts = { inspect: 0, read: 0 }
  const files: FileAccess = {
    inspect: (path, roots) => (counts.inspect++, base.inspect(path, roots)),
    read: (path, identity, max) => (counts.read++, base.read(path, identity, max)),
  }
  return { files, counts }
}


export interface ProbeOptions {
  readonly options?: Options
  readonly route?: RouteCapability
  readonly adapter?: Adapter
  readonly agentRules?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]
  readonly onAsk?: (request: AssertRequest) => Promise<"once" | "reject">
  readonly account?: Account | "needs_auth" | undefined
  readonly available?: () => InferenceError | undefined
  /** A transport to use instead of the recording fake. */
  readonly transport?: Transport
  /** The tool to register instead of the probe; its adapter is `adapter`. */
  readonly tool?: ToolSpec
  readonly now?: () => Date
}

/** Everything a pipeline test needs, wired the way src/host/plugin.ts wires it. */
export async function probeHarness(options: ProbeOptions = {}) {
  const root = tempRoot("probe")
  const project = join(root, "project")
  const state = join(root, "state")
  mkdirSync(project, { recursive: true })
  const config = loadConfig({ profiles: { probe: { model: PROBE_MODEL } }, ...options.options })
  const fixture = probeFixture(options.route)
  const fake = fakeContext({
    hostPermissions: true,
    ...(options.onAsk ? { onAsk: options.onAsk } : {}),
    agents: [{ id: "build", permissions: options.agentRules ?? [{ action: "*", resource: "*", effect: "allow" }] }],
    sessions: { ses_1: { agent: "build" } },
  })
  const { transport, sent, replies, ok } = fakeTransport("account" in options ? options.account : ACCOUNT)
  const { files, counts } = countingFiles()
  const store = createJournalStore(join(state, "journal"), { lockWaitMs: 200 })
  const journal = new Journal(store, "openrouter:0123456789abcdef", options.now)
  const runTool = createDispatcher({
    tools: [options.tool ?? PROBE],
    handlers: {},
    unavailable: options.available ?? (() => undefined),
    operations: {
      config,
      fixture,
      project: { id: "prj_fake", directory: project, worktree: project },
      files,
      authorize: createAuthorize((input) => fake.context.permission.assert(input)),
      transport: options.transport ?? transport,
      journal: () => journal,
      adapters: { [(options.tool ?? PROBE).name]: options.adapter ?? probeAdapter() },
      ...(options.now ? { now: options.now } : {}),
    },
  })
  const spec = options.tool ?? PROBE
  await fake.context.tool.transform(toolTransform(runTool, () => true, [spec]))
  await registerScripting(fake.context as never, runTool, () => undefined, undefined, [spec])
  const tool = fake.tools.find((item) => item.name === spec.name)!
  const call = (signal = new AbortController().signal, id = `call_${Math.random().toString(36).slice(2)}`) => ({ sessionID: "ses_1", agent: "build", messageID: "msg_1", id, signal, progress: async () => undefined })
  return {
    root,
    project,
    state,
    fake,
    sent,
    replies,
    ok,
    counts,
    journal,
    runTool,
    /** The model path: the host tool's execute. */
    model: (input: unknown, signal?: AbortSignal) => tool.execute(input, call(signal)),
    /** The tools RPC path, as a script. */
    rpc: (input: unknown) => fake.call(TOOLS_RPC_ID, spec.name, { sessionID: "ses_1", input }) as Promise<unknown>,
  }
}

export const textInput = (text = "Invoice AB-72. Total EUR 120.00.") => ({ profile: "probe", source: { kind: "text", text }, fields: { title: { type: "text" } } })
export const pathInput = (path: string) => ({ profile: "probe", source: { kind: "path", path }, fields: { title: { type: "text" } } })
