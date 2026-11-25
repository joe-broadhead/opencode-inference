// A test-only operation for the pipeline: a fake "probe" tool (class send, operation extract) with a fake adapter and a
// fake transport, run through the real `runOperation`, the real file access, the real journal store and createAuthorize
// over a rule-shaped fake assert. Nothing here reaches a network: the transport is a recorder. The contract's register
// owns the method action, so this harness asserts only the file effects the handler itself needs.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import * as z from "zod"
import { createAuthorize } from "../../src/authorize.js"
import { loadConfig, type Options } from "../../src/domain/config.js"
import { ExtractInput, InferenceResult } from "../../src/domain/contracts.js"
import { InferenceError } from "../../src/domain/errors.js"
import { files as hostFiles } from "../../src/files.js"
import { createJournalStore } from "../../src/journal-store.js"
import { OPENROUTER_CAPABILITIES, type CapabilityFixture, type RouteCapability } from "../../src/provider/capabilities.js"
import { TransportError, type Account, type Transport, type TransportRequest, type TransportResponse } from "../../src/provider/http.js"
import { Journal } from "../../src/runtime/journal.js"
import { runOperation, Slots, type Adapter, type OperationRuntime } from "../../src/runtime/operation.js"
import type { FileAccess } from "../../src/runtime/sources.js"
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
  canary: { status: "passed", on: "2026-11-12", reports: { request: "extractions-20261112T000000Z.json", malformed: "extractions-20261112T000001Z.json" }, wireRevision: "probe-adapter-1" },
  notes: [],
  ...overrides,
})

export const probeFixture = (route = probeRoute()): CapabilityFixture => ({ ...OPENROUTER_CAPABILITIES, revision: "test-fixture-1", routes: [route] })

export const ProbeData = z.strictObject({ fields: z.record(z.string(), z.string().nullable()) })

export interface TestTool {
  readonly name: string
  readonly input: z.ZodType
  readonly output: z.ZodType
}

/** The test-only operation. Registered nowhere but in these tests. */
export const PROBE: TestTool = {
  name: "probe",
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
export const ACCOUNT: Account = { alias: "default", integrationID: "inference", scope: "openrouter:0123456789abcdef", connection: { type: "credential", id: "cred_test", label: "test", method: "key" } as never }

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

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

export interface AssertRequest {
  readonly action: string
  readonly resources: readonly string[]
}

const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)
/** The host's last-match-wins evaluation for one action on one resource, and ask when nothing matches. */
const effectOn = (rules: readonly Rule[], action: string, resource: string): Rule["effect"] =>
  rules.findLast((rule) => wildcard(rule.action).test(action) && wildcard(rule.resource).test(resource))?.effect ?? "ask"
/** Deny if any requested resource is denied; otherwise the effect on the first, which is the one a person sees. */
const effectOf = (rules: readonly Rule[], request: AssertRequest): Rule["effect"] => {
  const effects = request.resources.length === 0 ? [effectOn(rules, request.action, "*")] : request.resources.map((resource) => effectOn(rules, request.action, resource))
  return effects.includes("deny") ? "deny" : (effects[0] ?? "ask")
}

export interface ProbeOptions {
  readonly options?: Options
  readonly route?: RouteCapability
  readonly adapter?: Adapter
  readonly agentRules?: readonly Rule[]
  readonly onAsk?: (request: AssertRequest) => Promise<"once" | "reject">
  readonly account?: Account | "needs_auth" | undefined
  /** A gate before the pipeline runs, such as a module turned off. */
  readonly available?: () => InferenceError | undefined
  /** A transport to use instead of the recording fake. */
  readonly transport?: Transport
  /** The tool to run instead of the probe; its adapter is `adapter`. */
  readonly tool?: TestTool
  readonly now?: () => Date
}

/** Everything a pipeline test needs, wired the way src/index.ts wires the operation runtime. */
export async function probeHarness(options: ProbeOptions = {}) {
  const root = tempRoot("probe")
  const project = join(root, "project")
  const state = join(root, "state")
  mkdirSync(project, { recursive: true })
  const config = loadConfig({ profiles: { probe: { model: PROBE_MODEL } }, ...options.options })
  const fixture = probeFixture(options.route)
  const rules = options.agentRules ?? [{ action: "*", resource: "*", effect: "allow" as const }]
  const asserted: AssertRequest[] = []
  const assert = async (input: { action: string; resources?: readonly string[] }) => {
    const request = { action: input.action, resources: input.resources ?? [] }
    asserted.push(request)
    const effect = effectOf(rules, request)
    if (effect === "deny") throw Object.assign(new Error(`Permission denied: ${request.action}`), { _tag: "Permission.BlockedError" })
    if (effect === "ask" && (await options.onAsk?.(request)) !== "once") throw Object.assign(new Error(`The user rejected ${request.action}`), { _tag: "Permission.DeclinedError" })
  }
  const { transport, sent, replies, ok } = fakeTransport("account" in options ? options.account : ACCOUNT)
  const { files, counts } = countingFiles()
  const store = createJournalStore(join(state, "journal"), { lockWaitMs: 200 })
  const journal = new Journal(store, ACCOUNT.scope, options.now)
  const tool = options.tool ?? PROBE
  const adapter = options.adapter ?? probeAdapter()
  const slots = new Slots(config.limits.concurrency)
  const runtime: OperationRuntime = {
    config,
    fixture,
    project: { id: "prj_fake", directory: project, worktree: project },
    files,
    authorize: createAuthorize(assert as never),
    transport: options.transport ?? transport,
    journal: () => journal,
    adapters: { [tool.name]: adapter },
    ...(options.now ? { now: options.now } : {}),
  }
  const call = (signal = new AbortController().signal) => ({ account: ACCOUNT.alias, sessionID: "ses_1", agent: "build", messageID: "msg_1", id: `call_${Math.random().toString(36).slice(2)}`, signal, progress: async () => undefined })
  const run = async (input: unknown, signal?: AbortSignal) => {
    const blocked = options.available?.()
    if (blocked) throw blocked
    const parsed = tool.input.parse(input)
    return runOperation({ name: tool.name }, adapter, parsed, call(signal), runtime, slots)
  }
  return {
    root,
    project,
    state,
    fake: { asserted },
    sent,
    replies,
    ok,
    counts,
    journal,
    /** The model path: the pipeline's output, with the text the tool door would show. */
    async model(input: unknown, signal?: AbortSignal) {
      const result = await run(input, signal)
      return { output: result.output, content: result.text }
    },
    /** The RPC path: the same pipeline; the register owns the envelope and the door's confirmation. */
    async rpc(input: unknown) {
      return (await run(input)).output
    },
  }
}

export const textInput = (text = "Invoice AB-72. Total EUR 120.00.") => ({ profile: "probe", source: { kind: "text", text }, fields: { title: { type: "text" } } })
export const pathInput = (path: string) => ({ profile: "probe", source: { kind: "path", path }, fields: { title: { type: "text" } } })
