// The Jobs recipe in docs/jobs.md, run exactly as written: the family's Jobs plugin (as released) runs the doc's script
// with the doc's manifest through `jobs_run_script` on the embedded OpenCode host, next to this plugin and the released
// Utilities plugin. Jobs resolves `inference.core.extract` and `utilities.local.time_add` through each plugin's tools RPC,
// binds them as `tools.inference.core.extract` and `tools.utilities.local.time_add`, and the extraction reaches a loopback
// fake OpenRouter. The fake leaves `net_days` absent, so the script returns for review before it would call time_add
// (Utilities' time program is downloaded on first use, which this offline test must not do); the binding is still
// resolved and approved by Jobs.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { WIRE_REVISION as EXTRACTIONS_REVISION } from "../../src/providers/openrouter/extractions.js"
import { createPlugin } from "../../src/host/plugin.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { cleanup, familyPlugin, HOST_VERSION, REPO, root, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(300_000)
afterAll(cleanup)

const FAKE_KEY = "sk-or-v1-host-jobs-fake-key-0123456789"
const DOC = readFileSync(join(REPO, "docs/jobs.md"), "utf8")
const block = (name: string, language: string) => {
  const found = new RegExp(`<!-- recipe: ${name} -->\\n\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``).exec(DOC)?.[1]
  if (found === undefined) throw new Error(`docs/jobs.md has no ${name} block`)
  return found
}
const CODE = block("code", "js")
const USES = JSON.parse(block("uses", "json")) as string[]
const fixture = {
  ...OPENROUTER_CAPABILITIES,
  revision: "host-test-jobs-1",
  routes: OPENROUTER_CAPABILITIES.routes.map((route) =>
    route.model === "cloudflare/clairic" ? { ...route, enabled: true, canary: { status: "passed" as const, on: "2026-11-12", reports: { request: "extractions-20261112T000000Z.json", malformed: "extractions-20261112T000001Z.json" }, wireRevision: EXTRACTIONS_REVISION }, pricing: { revision: "host-test", currency: "USD" as const, perRequest: "0.004", upperBound: true } } : route,
  ),
}
const ANSWER = JSON.stringify({
  id: "gen-jobs-1",
  model: "cloudflare/clairic",
  answers: { issued_on: { type: "date", value: "2026-11-01", confidence: 0.9, span: [22, 32] }, net_days: { type: "number", value: null, p_null: 0.7 } },
  usage: { cost: 0.000003 },
})

interface Tool {
  execute(input: unknown, context: unknown): Promise<{ output?: Record<string, any> }>
}

describe(`the Jobs recipe on OpenCode ${HOST_VERSION} (embedded SDK), with the released Jobs and Utilities plugins`, () => {
  let host: Host
  let server: Server
  let sessionID: string
  const seen: { path: string; authorization: string | undefined; body: Record<string, any> }[] = []
  const call = (id: string) => ({ sessionID, agent: "build", messageID: `msg_${id}`, id, signal: new AbortController().signal, progress: async () => undefined, source: { type: "tool", messageID: `msg_${id}`, id } })
  const runScript = async (code: string, uses: string[], id: string) => {
    const tool = (await host.context!()!.tool.list()).find((entry) => entry.id === "jobs_run_script") as unknown as Tool
    return tool.execute({ code, uses, agent: "build" }, call(id)).then(
      (result) => ({ output: result.output }),
      (error: Error) => ({ error: String(error.message) }),
    )
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      request.on("end", () => {
        seen.push({ path: request.url ?? "", authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, any> })
        response.writeHead(200, { "content-type": "application/json" })
        response.end(ANSWER)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const [jobs, utilities] = await Promise.all([familyPlugin("jobs"), familyPlugin("utilities")])
    host = await startHost({ plugin: createPlugin({ packageRoot: REPO, fixture, transportOrigin: origin, stateRoot: join(root, "inference-state-jobs") }), plugins: [jobs, utilities] })
    sessionID = (await host.client.session.create({ agent: "build", location: host.location })).id
    await until("the location's tools include jobs_run_script and the inference tools", async () => {
      const ids = (await host.context?.()?.tool.list())?.map((tool) => tool.id) ?? []
      return ids.includes("jobs_run_script") && ids.includes("inference_extract") && ids.includes("utilities_time_add")
    })
    await host.client.integration.connect.key({ integrationID: "inference-openrouter", key: FAKE_KEY, label: "Host test", location: host.location })
  })
  afterAll(async () => {
    await host?.close()
    server?.close()
  })

  test("Jobs runs the documented script with the documented manifest; the nested bindings resolve and the result keeps its review", async () => {
    expect(USES).toEqual(["inference.core.extract", "utilities.local.time_add"])
    const result = await runScript(CODE, USES, "call_recipe")
    expect(result).toMatchObject({ output: { ok: true } })
    const value = (result as { output: Record<string, any> }).output.value
    // net_days was absent: no due date is guessed, and the review travels with the operation id.
    expect(value).toMatchObject({ draft: null, missing: ["net_days"], review: { required: true, profileVersion: "review-first-v1" } })
    expect(value.review.reasons).toContain("REQUIRED_FIELD_ABSENT")
    expect(value.operationId).toMatch(/^op_[0-9a-f-]{36}$/)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path: "/api/alpha/extractions", authorization: `Bearer ${FAKE_KEY}`, body: { model: "cloudflare/clairic", fields: { issued_on: { type: "date" }, net_days: { type: "number", integer: true } } } })
  })

  test("a manifest entry or accessor that is not the exact nested name is refused, and nothing is sent", async () => {
    // A method the inference.core tools RPC does not list is refused when Jobs resolves the manifest.
    const unknown = await runScript("return await tools.inference.core.extrakt({})", ["inference.core.extrakt"], "call_extrakt")
    expect((unknown as { error?: string }).error).toMatch(/^JOBS_SCRIPT_UNKNOWN_TOOL: The manifest names a tool the host does not list: "inference\.core\.extrakt"/)
    // The plugin id is inference.core, not inference: the short accessor is refused when the script calls it.
    const short = await runScript("return await tools.inference.extract({})", ["inference.extract"], "call_short")
    expect(short).toMatchObject({ output: { ok: false, error: expect.stringMatching(/^JOBS_SCRIPT_UNKNOWN_TOOL: /) } })
    expect(seen).toHaveLength(1)
  })
})
