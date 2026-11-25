// The built package as users get it: `npm pack`, then `npm install --ignore-scripts --offline` of the tarball into an
// empty project. The installed package then loads in the real embedded OpenCode 2.4.1 host, and its two entries import
// with the host modules supplied. Run after `npm run bundle` (the full check does).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createHost } from "@we-the-rebel-alliance/plugin-contract/kit"
import { tempRoot } from "../support/temp.js"

setDefaultTimeout(300_000)
const REPO = fileURLToPath(new URL("../../", import.meta.url))
const NAME = "@we-the-rebel-alliance/inference-plugin"
const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|assets\/icon(-128|-256)?\.(svg|png)|dist\/(index|tui)\.js|skills\/inference(?:-(extract|decide))?\/SKILL\.md)$/
const REQUIRED = ["package.json", "README.md", "LICENSE", "NOTICE", "assets/icon.svg", "assets/icon-128.png", "assets/icon-256.png", "dist/index.js", "dist/tui.js", "skills/inference/SKILL.md", "skills/inference-extract/SKILL.md", "skills/inference-decide/SKILL.md"]
const HOST_MODULES = /^(@opencode\/plugin(\/.+)?|@opentui\/(core|solid)(\/.+)?|solid-js(\/.+)?)$/
const UI_MODULES = /^(@opentui\/|solid-js)/

const work = tempRoot("pack")
const project = join(work, "project")
const installed = join(project, "node_modules", NAME)

type Packed = { filename: string; size: number; unpackedSize: number; entryCount: number; files: { path: string }[] }
let packed: Packed

async function npm(args: string[], cwd: string): Promise<string> {
  const run = Bun.spawn(["npm", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" } })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(`npm ${args.join(" ")} failed (${code}):\n${stderr}`)
  return stdout
}

beforeAll(async () => {
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "inference-pack-test", version: "0.0.0", private: true }))
  if (!existsSync(join(REPO, "dist/index.js"))) throw new Error("dist/ is missing. Run npm run bundle first.")
  ;[packed] = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", work], REPO)) as [Packed]
  await npm(["install", "--ignore-scripts", "--offline", join(work, packed.filename)], project)
})

const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))
const manifest = () => JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as Record<string, any>

describe("the tarball", () => {
  test("holds only dist, the three icons, the two skills, README, LICENSE, NOTICE and package.json", () => {
    const paths = packed.files.map((file) => file.path)
    expect(paths.filter((path) => !ALLOWED.test(path))).toEqual([])
    expect(REQUIRED.filter((path) => !paths.includes(path))).toEqual([])
    expect(packed.unpackedSize).toBeLessThan(1024 * 1024)
  })

  test("declares no dependencies or lifecycle scripts, the exact host range, and the two standard exports", () => {
    const pkg = manifest()
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "overrides", "sources", "opencode"]) expect(pkg[field]).toBeUndefined()
    expect(Object.keys(pkg["scripts"] ?? {}).filter((script) => ["preinstall", "install", "postinstall", "prepare", "prepack"].includes(script))).toEqual([])
    expect(pkg["type"]).toBe("module")
    expect(pkg["capabilities"]["plugin"]["host"]).toEqual({ opencode: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
    expect(pkg["exports"]).toEqual({ "./server": "./dist/index.js", "./tui": "./dist/tui.js" })
    for (const target of Object.values(pkg["exports"] as Record<string, string>)) expect(existsSync(join(installed, target))).toBe(true)
  })
})

describe("the install", () => {
  test("adds only this package, with no nested modules", () => {
    const visible = (directory: string) => readdirSync(directory).filter((entry) => !entry.startsWith("."))
    expect(visible(join(project, "node_modules"))).toEqual(["@we-the-rebel-alliance"])
    expect(visible(join(project, "node_modules", "@we-the-rebel-alliance"))).toEqual(["inference-plugin"])
    expect(existsSync(join(installed, "node_modules"))).toBe(false)
  })

  test("dist holds exactly index.js and tui.js; neither imports a relative path or requires, only Node and host modules", () => {
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

  test("the contract and zod are bundled into dist/index.js, and NOTICE covers each", () => {
    expect(readFileSync(join(installed, "dist/index.js"), "utf8")).toContain("// node_modules/zod/")
    expect(readFileSync(join(installed, "dist/index.js"), "utf8")).toContain("// node_modules/@we-the-rebel-alliance/plugin-contract/")
    for (const name of ["zod", "@we-the-rebel-alliance/plugin-contract"]) expect(readFileSync(join(installed, "NOTICE"), "utf8")).toContain(`## ${name} `)
    expect(readFileSync(join(installed, "dist/tui.js"), "utf8")).not.toContain("node_modules/zod/")
  })

  test("imports both entries when the host modules are supplied", async () => {
    for (const name of ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]) {
      mkdirSync(join(work, "node_modules", dirname(name)), { recursive: true })
      if (!existsSync(join(work, "node_modules", name))) symlinkSync(join(REPO, "node_modules", name), join(work, "node_modules", name), "dir")
    }
    const server = await import(join(installed, "dist/index.js"))
    const tui = await import(join(installed, "dist/tui.js"))
    expect(server.default.id).toBe("inference")
    expect(tui.default.id).toBe("inference.tui")
  })

  test("the installed package starts in the real OpenCode 2.4.1 host with its six methods", async () => {
    const run = await createHost({ directory: installed, version: "2.4.1", pluginId: "inference", options: { access: "all", accounts: { work: {}, personal: {} } } })
    try {
      expect(run.failure).toBeUndefined()
      expect(run.refusal).toBeUndefined()
      expect(run.definition?.id).toBe("inference")
      expect(run.tools.map((tool) => tool.name).sort()).toEqual(["capabilities", "decide", "extract", "plan", "probe", "status"])
      const status = await run.call("status", {})
      expect(status.ok && (status.output as { version: string }).version).toBe("0.0.0")
    } finally {
      await run.close()
    }
  })
})
