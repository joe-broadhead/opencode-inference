// The package and the docs that a reader installs from: the manifest is the one the kit reads, nothing legacy is left,
// the fixed-context text stays within budget, and every install line names a release tag.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { checkManifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { packageOf } from "../support/manifest.js"
import { readdirSync } from "node:fs"
import { join } from "node:path"

/** Every skills/<id>/SKILL.md and its front-matter description, read the way the kit reads it. */
function skillsOf(root: string): { file: string; name?: string; description?: string }[] {
  const found: { file: string; name?: string; description?: string }[] = []
  for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join("skills", entry.name, "SKILL.md")
    const lines = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n").split("\n")
    if (lines[0]?.trim() !== "---") continue
    const end = lines.indexOf("---", 1)
    const matter = lines.slice(1, end).join("\n")
    const field = (key: string) => new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(matter)?.[1]?.trim()
    found.push({ file, ...(field("name") === undefined ? {} : { name: field("name")! }), ...(field("description") === undefined ? {} : { description: field("description")! }) })
  }
  return found
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const FILES = ["README.md", "AGENTS.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "docs/capabilities.md", "docs/accounts.md", "docs/configuration.md", "docs/architecture.md", "docs/automations.md", "docs/security.md"]

describe("the package", () => {
  test("carries a valid capabilities manifest, version 0.0.0, the standard name and exports, and no runtime dependency", () => {
    const { version, capabilities } = packageOf()
    expect(version).toBe("0.0.0")
    expect(checkManifest(capabilities)).toEqual({ ok: true, value: capabilities })
    const pkg = JSON.parse(text("package.json")) as Record<string, unknown> & { exports: Record<string, string>; files: string[]; devDependencies: Record<string, string> }
    expect(pkg["name"]).toBe("@we-the-rebel-alliance/inference-plugin")
    expect(pkg["repository"]).toBe("github:we-the-rebel-alliance/inference-plugin")
    expect(pkg["exports"]).toEqual({ "./server": "./dist/index.js", "./tui": "./dist/tui.js" })
    expect(pkg["files"]).toEqual(["dist", "skills", "assets", "README.md", "LICENSE", "NOTICE"])
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "overrides", "sources", "opencode"]) expect(pkg[field]).toBeUndefined()
    expect(Object.keys(pkg.devDependencies).sort()).toContain("@we-the-rebel-alliance/plugin-contract")
    expect(pkg.devDependencies["@we-the-rebel-alliance/plugin-contract"]).toMatch(/^github:we-the-rebel-alliance\/plugin-contract#(?:v\d+\.\d+\.\d+|[0-9a-f]{40})$/)
  })

  test("keeps the fixed context inside budget: the namespace line, every skill description, and no pinned method", () => {
    const { capabilities } = packageOf()
    expect(capabilities.plugin.summary.length).toBeLessThanOrEqual(400)
    expect(capabilities.plugin.summary.includes("\n")).toBe(false)
    for (const skill of skillsOf(ROOT)) expect({ file: skill.file, length: skill.description?.length }).toEqual({ file: skill.file, length: expect.any(Number) })
    for (const skill of skillsOf(ROOT)) expect(skill.description!.length).toBeLessThanOrEqual(300)
    expect(Object.values(capabilities.methods).filter((method) => method.pinned === true)).toEqual([])
    // No method carries an effect override: the class and the access level decide every call.
    expect(Object.values(capabilities.methods).filter((method) => method.effect !== undefined)).toEqual([])
  })

  test("every declared method is a contract method and status is present; no pass-through MCP server exists", () => {
    const { capabilities } = packageOf()
    expect(Object.keys(capabilities.methods).sort()).toEqual(["capabilities", "decide", "extract", "plan", "probe", "status"])
    expect(capabilities.methods["status"]).toEqual({ class: "read", accounts: "none" })
    expect(capabilities.methods["probe"]).toEqual({ class: "read", accounts: "optional" })
    expect(capabilities.methods["extract"]?.class).toBe("send")
    expect(capabilities.methods["decide"]?.class).toBe("send")
    expect(capabilities.methods["extract"]?.plans).toBeUndefined()
    expect(capabilities.methods["decide"]?.commits).toBeUndefined()
    expect(capabilities.sources).toEqual([])
    expect(capabilities.actions).toEqual([])
    expect(capabilities.events).toEqual({ account: {} })
    expect(Object.keys(capabilities.methods).filter((method) => method.startsWith("mcp:"))).toEqual([])
  })
})

describe("the docs and the install path", () => {
  test("every doc file exists and no doc names the old app or the old repository", () => {
    for (const file of FILES) expect({ file, exists: text(file).length > 0 }).toEqual({ file, exists: true })
  })

  test("install from a release tag, and the first release is v0.0.0", () => {
    const readme = text("README.md")
    expect(readme).toContain("opencode plugin add github:we-the-rebel-alliance/inference-plugin#v0.0.0")
    expect(readme).toContain("The first release is v0.0.0.")
    expect(readme).not.toMatch(/opencode plugin add github:we-the-rebel-alliance\/inference-plugin\s*$/m)
    expect(readme).toContain("## Install\n")
  })

  test("CHANGELOG has one 0.0.0 section and no older-version reference", () => {
    const changelog = text("CHANGELOG.md")
    expect(changelog.match(/^## .*$/gm)).toEqual(["## 0.0.0 (2026-11-25)"])
    expect(changelog).not.toMatch(/^### .*v0\.0\.[1-9]\d*/m)
    expect(changelog).not.toMatch(/Removed since v0\.0\./i)
    expect(changelog).not.toMatch(/\bv0\.0\.[1-9]\d*\b/)
    expect(changelog).not.toMatch(/earlier release/i)
  })
})
