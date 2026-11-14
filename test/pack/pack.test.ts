// The built package as users get it: `npm pack`, then `npm install --ignore-scripts --offline` of the tarball into an
// empty project. Run after `npm run build` (check does). PACK_TARBALL tests an already packed tarball instead. The
// installed package then loads in each stock OpenCode release it is tested on (startStock in ../host/harness.ts), where
// its status RPC, tools RPC, default rules and /connect entry are checked. Nothing leaves loopback.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { loadConfig } from "../../src/domain/config.js"
import { TOOL_NAMES, TOOLS } from "../../src/domain/registry.js"
import { keyRequired } from "../../src/host/status.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"
import { defaultRules } from "../../src/host/permissions.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { cleanup, npm, REPO, root, startStock, STOCK_VERSIONS, until, type Host } from "../host/harness.js"

setDefaultTimeout(300_000)

const NAME = "@joe-broadhead/opencode-inference"
const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|assets\/icon(-128|-256)?\.(svg|png)|dist\/(index|tui)\.js|skills\/inference-(extract|decide)\/SKILL\.md)$/
const REQUIRED = ["package.json", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md", "assets/icon.svg", "assets/icon-128.png", "assets/icon-256.png", "dist/index.js", "dist/tui.js", "skills/inference-extract/SKILL.md", "skills/inference-decide/SKILL.md"]
const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish", "preuninstall", "uninstall", "postuninstall", "dependencies"]
const HOST_MODULES = /^(@opencode\/plugin(\/.+)?|@opentui\/(core|solid)(\/.+)?|solid-js(\/.+)?)$/
const UI_MODULES = /^(@opentui\/|solid-js)/

const work = join(root, "pack")
const project = join(work, "project")
const installed = join(project, "node_modules", NAME)

type Packed = { filename: string; size: number; unpackedSize: number; entryCount: number; files: { path: string }[] }
let packed: Packed
let manifest: Record<string, any>

beforeAll(async () => {
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "inference-pack-test", version: "0.0.0", private: true }))
  let tarball: string
  if (process.env.PACK_TARBALL) {
    tarball = resolve(process.env.PACK_TARBALL)
    ;[packed] = JSON.parse(await npm(["pack", "--dry-run", "--ignore-scripts", "--json", tarball], project)) as [Packed]
  } else {
    if (!existsSync(join(REPO, "dist/index.js"))) throw new Error("dist/ is missing. Run npm run build first.")
    ;[packed] = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", work], REPO)) as [Packed]
    tarball = join(work, packed.filename)
  }
  await npm(["install", "--ignore-scripts", "--offline", tarball], project)
  manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
})
afterAll(cleanup)

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))

describe("the tarball", () => {
  test("holds only dist/index.js, dist/tui.js, the three icons, the two skills, README, LICENSE, NOTICE, CHANGELOG and package.json", () => {
    const paths = packed.files.map((file) => file.path)
    expect(paths.filter((path) => !ALLOWED.test(path))).toEqual([])
    expect(REQUIRED.filter((path) => !paths.includes(path))).toEqual([])
    expect(packed.unpackedSize).toBeLessThan(1024 * 1024)
  })

  test("declares no dependencies, peers or lifecycle scripts, the exact host range, and only the five exports", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides"]) expect(manifest[field]).toBeUndefined()
    expect(Object.keys(manifest.scripts ?? {}).filter((script) => LIFECYCLE.includes(script))).toEqual([])
    expect(manifest.type).toBe("module")
    expect(manifest.opencode.host).toBe(">=2.2.3 <2.3.0")
    expect(manifest.exports).toEqual({ ".": "./dist/index.js", "./tui": "./dist/tui.js", "./icon.svg": "./assets/icon.svg", "./icon-128.png": "./assets/icon-128.png", "./icon-256.png": "./assets/icon-256.png" })
    for (const target of Object.values(manifest.exports as Record<string, string>)) expect(existsSync(join(installed, target))).toBe(true)
  })
})

describe("the install", () => {
  test("adds only this package", () => {
    const visible = (directory: string) => readdirSync(directory).filter((entry) => !entry.startsWith("."))
    expect(visible(join(project, "node_modules"))).toEqual(["@joe-broadhead"])
    expect(visible(join(project, "node_modules", "@joe-broadhead"))).toEqual(["opencode-inference"])
    expect(existsSync(join(installed, "node_modules"))).toBe(false)
  })

  test("dist holds exactly index.js and tui.js; neither imports a relative path or requires; only Node and host modules", () => {
    expect(files(join(installed, "dist")).map((file) => relative(installed, file)).sort()).toEqual(["dist/index.js", "dist/tui.js"])
    const scanner = new Bun.Transpiler({ loader: "js" })
    for (const where of ["dist/index.js", "dist/tui.js"]) {
      const text = readFileSync(join(installed, where), "utf8")
      for (const { path } of scanner.scan(text).imports) {
        expect({ where, path, allowed: path.startsWith("node:") || HOST_MODULES.test(path) }).toEqual({ where, path, allowed: true })
        if (where !== "dist/tui.js") expect({ where, ui: UI_MODULES.test(path) }).toEqual({ where, ui: false })
      }
      expect({ where, require: /\brequire\s*\(/.test(text) }).toEqual({ where, require: false })
    }
  })

  test("zod is bundled into dist/index.js only, and NOTICE covers it", () => {
    expect(readFileSync(join(installed, "dist/index.js"), "utf8")).toContain("// node_modules/zod/")
    expect(readFileSync(join(installed, "dist/tui.js"), "utf8")).not.toContain("node_modules/zod/")
    expect(readFileSync(join(installed, "NOTICE"), "utf8")).toContain("## zod ")
  })

  test("imports dist/index.js and dist/tui.js when the host modules are supplied", async () => {
    for (const name of ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]) {
      mkdirSync(join(work, "node_modules", dirname(name)), { recursive: true })
      if (!existsSync(join(work, "node_modules", name))) symlinkSync(join(REPO, "node_modules", name), join(work, "node_modules", name), "dir")
    }
    const server = await import(join(installed, "dist/index.js"))
    const tui = await import(join(installed, "dist/tui.js"))
    expect(server.default.id).toBe("inference.core")
    expect(tui.default.id).toBe("inference.core.tui")
  })
})

async function rpc(host: Host, rpcID: string, method: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: (await host.client.rpc.call({ rpcID, method, input: input as never, location: host.location })).output }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

for (const version of STOCK_VERSIONS)
  describe(`the installed package on stock OpenCode ${version}`, () => {
    let host: Host
    beforeAll(async () => {
      host = await startStock(version, installed, { agents: { locked: { permissions: [{ action: "inference_*", resource: "*", effect: "deny" }] } } })
    })
    afterAll(() => host?.close())

    test("loads from its directory with its server and TUI parts", async () => {
      const { data: plugins } = await host.client.plugin.list({ location: host.location })
      const entry = plugins.find((plugin) => plugin.id === "inference.core")
      expect(entry?.state).toEqual({ status: "active" })
      expect(entry?.source).toEqual({ type: "local", path: expect.stringContaining(join("node_modules", NAME)) })
      expect(entry?.features).toEqual({ server: true, tui: true })
    })

    test("answers status, registers /inference-status and the /connect entry, and inserts the default rules", async () => {
      const status = await rpc(host, "inference.core", "status", {})
      // The committed fixture as installed: with an enabled route the key is needed, and connecting it is the next step.
      const required = keyRequired(loadConfig({}), OPENROUTER_CAPABILITIES)
      expect(status.value).toMatchObject({
        version: manifest.version,
        state: required ? "sign_in_required" : "local_only",
        nextStep: required ? "Run /connect and choose OpenRouter key for Inference, then enter an OpenRouter API key." : "Nothing to do.",
        host: { version, range: ">=2.2.3 <2.3.0", tested: true },
        connection: { state: "not_connected", required },
      })
      const { data: commands } = await host.client.command.list({ location: host.location })
      expect(commands.map((command) => command.name)).toContain("inference-status")
      // The packaged skills load from the installed tarball.
      const { data: skills } = await host.client.skill.list({ location: host.location })
      expect(skills.map((skill: { name: string }) => skill.name).filter((name: string) => name.startsWith("inference-")).sort()).toEqual(["inference-decide", "inference-extract"])
      const { data: integrations } = await host.client.integration.list({ location: host.location })
      expect(integrations.find((entry) => entry.id === "inference-openrouter")?.name).toBe("OpenRouter key for Inference")
      const { data: agents } = await host.client.agent.list({ location: host.location })
      const build = agents.find((agent) => agent.id === "build")!.permissions
      expect(build.slice(0, 1 + defaultRules().length)).toEqual([{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()])
    })

    test("the tools RPC describes the registry's methods and classes and runs plan as a session; a denying agent is refused", async () => {
      const described = await rpc(host, TOOLS_RPC_ID, "describe", {})
      expect(described.value.methods.map((method: { name: string; class: string }) => [method.name, method.class])).toEqual(TOOLS.map((tool) => [tool.name, tool.class]))
      const session = async (agent: string) => (await host.client.session.create({ agent, location: host.location })).id
      const input = { task: "extract", input: { source: { kind: "text", text: "Total EUR 120.00" }, profile: "extract-typed", fields: { total: { type: "number" } } } }
      const planned = await rpc(host, TOOLS_RPC_ID, "plan", { sessionID: await session("build"), input })
      const enabled = (model: string) => OPENROUTER_CAPABILITIES.routes.find((route) => route.model === model)!.enabled
      expect(planned.value).toMatchObject({ task: "extract", route: { status: enabled("cloudflare/clairic") ? "eligible" : "ineligible" } })
      expect(await rpc(host, TOOLS_RPC_ID, "plan", { sessionID: await session("locked"), input })).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
      // The built extract and decide run as a session and stop before reading the key or sending: an enabled route at
      // the missing key, a disabled one at the route.
      const stop = (model: string) => (enabled(model) ? "AUTH_REQUIRED" : "CAPABILITY_UNSUPPORTED")
      expect(await rpc(host, TOOLS_RPC_ID, "extract", { sessionID: await session("build"), input: input.input })).toMatchObject({ type: "failed", code: stop("cloudflare/clairic") })
      const decide = { source: { kind: "text", text: "Paid in full." }, profile: "decide-text", questions: { paid: { type: "noul", prompt: "Paid?" } } }
      expect(await rpc(host, TOOLS_RPC_ID, "decide", { sessionID: await session("build"), input: decide })).toMatchObject({ type: "failed", code: stop("typesafe/jev-1.14") })
      await until("the server log is written", async () => host.log !== undefined)
    })
  })
