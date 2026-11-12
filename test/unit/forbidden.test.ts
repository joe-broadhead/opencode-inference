import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = new URL("../../scripts/check-forbidden.mjs", import.meta.url).pathname
const repo = new URL("../../", import.meta.url).pathname.replace(/\/$/, "")
const { networkProblemsAll } = (await import(new URL("../../scripts/check-network.mjs", import.meta.url).href as string)) as {
  networkProblemsAll: (root: string, files: Record<string, string>) => Record<string, [number, string][]>
}

/** The network check's messages for each text, type-checked together as files in src/host/ of this repository. */
const networkEach = (texts: readonly string[], dir = "src/host") => {
  const files = Object.fromEntries(texts.map((text, index) => [`${dir}/__lint_${index}.ts`, text]))
  const found = networkProblemsAll(repo, files)
  return texts.map((_, index) => (found[`${dir}/__lint_${index}.ts`] ?? []).map(([, message]) => message))
}

/** Runs the lint on a scratch git repo holding one source file (FORBIDDEN_ROOT), and returns its output. */
const lint = (path: string, content: string) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "forbidden-"))
  try {
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true })
    writeFileSync(join(dir, path), content)
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const run = spawnSync("node", [script], { cwd: dir, encoding: "utf8", env: { ...process.env, FORBIDDEN_ROOT: dir } })
    return run.stderr + run.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs the lint once on a scratch repo holding several files. */
const lintMany = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "forbidden-"))
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const run = spawnSync("node", [script], { cwd: dir, encoding: "utf8", env: { ...process.env, FORBIDDEN_ROOT: dir } })
    return run.stderr + run.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}


test("the lint refuses fs imports in the domain and the runtime", () => {
  for (const specifier of ["node:fs", "fs", "node:fs/promises", "fs/promises"]) {
    for (const path of ["src/domain/x.ts", "src/runtime/x.ts"]) {
      expect(lint(path, `import { readFileSync } from "${specifier}"\n`)).toContain("filesystem access in the domain or runtime")
    }
  }
}, 120_000)

test("the lint allows fs in the host layer", () => {
  expect(lint("src/host/x.ts", `import { readFileSync } from "node:fs"\n`)).not.toContain("filesystem access")
}, 60_000)

test("the network check refuses each reviewed bypass of the old text rule", () => {
  const bypasses = {
    "template dynamic import": "const h = await import(`node:https`)",
    "computed dynamic import": "const name = 'https'; const h = await import(name)",
    getBuiltinModule: 'const h = process.getBuiltinModule("node:https")',
    "getBuiltinModule by string": 'const h = process["getBuiltinModule"]("https")',
    createRequire: 'import { createRequire } from "node:module"\nconst h = createRequire(import.meta.url)("https")',
    "bare module": 'import { createRequire } from "module"',
    "child_process curl": 'import { execFile } from "node:child_process"\nexecFile("curl", ["https://x"])',
    worker_threads: 'import { Worker } from "worker_threads"',
    "connection alias": "const c = integration.connection\nawait c.resolve(x)",
    "resolve on another line": "await integration\n  .connection\n  .resolve(x)",
    "resolve on a connection variable": "await connection\n  .resolve(x)",
    "Reflect.get": 'const r = Reflect.get(connection, "resolve")',
    "globalThis concatenation": 'const f = globalThis["fet" + "ch"]',
    "globalThis alias": "const g = globalThis\nconst f = g.fetch",
    "destructured connection": "const { connection } = ctx.integration",
    "computed connection": 'const r = ctx.integration["connection"]',
    "import.meta.require": 'const h = import.meta.require("https")',
    "require as a value": "const r = require\nr('https')",
    "Bun.connect": "await Bun.connect({ hostname: 'x', port: 1 })",
    // The second review's bypasses of the deny-list.
    eval: 'eval("fetch(1)")',
    "indirect eval": '(0, eval)("fetch(1)")',
    "new Function": 'new Function("return this")()',
    "Function call": 'const g = Function("return this")()',
    "constructor route": '({}).constructor.constructor("return this")()',
    "bun module connect": 'import B from "bun"\nawait B.connect({ hostname: "x", port: 1 })',
    "bun spawn and $": 'import { spawn, $ } from "bun"',
    "node:vm": 'import vm from "node:vm"',
    _http_client: 'import c from "_http_client"',
    _tls_wrap: 'const t = require("_tls_wrap")',
    "getBuiltinModule from node:process": 'import { getBuiltinModule } from "node:process"',
    "getBuiltinModule destructured from process": "const { getBuiltinModule } = process",
    "process aliased": "const p = process\nconst h = p.getBuiltinModule",
    "computed process": "const k = 'env'\nconst v = process[k]",
    "computed names on an integration alias": 'const i = ctx.integration\nawait i["conn" + "ection"]["reso" + "lve"](c)',
    "computed names on integration": 'await ctx.integration["conn" + "ection"]["reso" + "lve"](c)',
    "global alias": "const g = global\nconst f = g.fetch",
    "self as a value": "const s = self",
    "module.require": 'const h = module.require("https")',
    "Reflect.apply": "Reflect.apply(f, undefined, [])",
    "Reflect.construct": "Reflect.construct(C, [])",
    "unprefixed builtin": 'import { readFileSync } from "fs"',
    "unlisted package": 'import got from "got"',
    "template with substitution": "const m = 'https'\nconst h = await import(`node:${m}`)",
  }
  const files = Object.fromEntries(Object.values(bypasses).map((text, index) => [`src/host/bypass${index}.ts`, `${text}\n`]))
  const output = lintMany(files)
  const caught = Object.keys(bypasses).map((name, index) => ({ name, caught: output.includes(`src/host/bypass${index}.ts:`) }))
  expect(caught).toEqual(Object.keys(bypasses).map((name) => ({ name, caught: true })))
}, 60_000)

test("modules are an allow-list: relative paths inside src/, the listed node: builtins and the listed packages", () => {
  const refused = ["http", "https", "http2", "net", "tls", "dns", "dns/promises", "dgram", "undici", "child_process", "worker_threads", "module", "vm", "process", "util", "fs", "path", "_http_client", "_tls_wrap"]
  const names = [...refused.map((name) => `node:${name}`).filter((name) => !["node:fs", "node:path"].includes(name)), ...refused, "bun", "bun:ffi", "got", "@opencode/client", "../../scripts/zz-net.mjs", "../../test/support/network-spy.js", "../../node_modules/undici/index.js", "../../../x.js"]
  const forms = (name: string) => [`import x from "${name}"`, `export * from "${name}"`, `const x = await import("${name}")`, `const x = require("${name}")`, `import x = require("${name}")`, `type T = typeof import("${name}")`]
  const bad = names.flatMap((name) => forms(name).map((form) => ({ name, form })))
  const found = networkEach(bad.map((item) => item.form))
  expect(bad.filter((item, index) => !found[index]!.includes(`a module outside the allow-list: ${item.name}`))).toEqual([])
  const good = ["node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:url", "zod", "@opencode/plugin", "@opencode/plugin/rpc", "solid-js", "./x.js", "../domain/ids.js", "../../src/domain/ids.js"]
    .flatMap((name) => [`import x from "${name}"`, `export * from "${name}"`, `const x = await import("${name}")`])
  expect(networkEach(good).flat()).toEqual([])
}, 120_000)

test("the current src/ passes the network check unchanged", () => {
  const files = execFileSync("git", ["ls-files", "src"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean)
  const found = networkProblemsAll(repo, Object.fromEntries(files.map((file) => [file, readFileSync(join(repo, file), "utf8")])))
  expect(Object.entries(found).flatMap(([file, problems]) => problems.map(([line, message]) => `${file}:${line}: ${message}`))).toEqual([])
}, 60_000)

test("the network check refuses every network global, however it is reached", () => {
  const texts = [`await fetch("https://x")`, "const f = globalThis.fetch", "const { fetch } = globalThis", 'const f = globalThis["fetch"]', "new WebSocket(u)", "new XMLHttpRequest()", "new EventSource(u)", "Bun.spawn(['curl'])"]
  expect(networkEach(texts).map((found) => found.length > 0)).toEqual(texts.map(() => true))
}, 60_000)

test("the last round's bypasses: process members, prototypes, property definition, computed keys and import.meta", () => {
  const bypasses = {
    "process.execve": 'process.execve("/usr/bin/curl", ["curl", "https://x"])',
    "process.binding": 'const b = process["binding"]',
    "process.dlopen": "process.dlopen(m, f)",
    "constructor string": 'const F = ({} as any)["constructor"]["constructor"]',
    "prototype string": 'const p = (Object as any)["prototype"]',
    "__proto__ string": 'const p = ({} as any)["__proto__"]',
    "constructor via a const": 'const k = "constructor"\nconst F = ({} as any)[k][k]',
    "getOwnPropertyDescriptor": 'const d = Object.getOwnPropertyDescriptor(o, "x")',
    "getOwnPropertyDescriptors": "const d = Object.getOwnPropertyDescriptors(o)",
    "defineProperty": 'Object.defineProperty(o, "x", { get: () => 1 })',
    "defineProperties": "Object.defineProperties(o, {})",
    "setPrototypeOf": "Object.setPrototypeOf(o, null)",
    "Reflect.get": 'Reflect.get(o, "x")',
    "wide string key": "declare const key: string\ndeclare const o: Record<string, unknown>\nconst v = o[key]",
    "any key": "declare const key: any\nconst v = ({} as any)[key]",
    "concatenated key on any object": 'declare const o: any\nconst v = o["con" + "structor"]',
    "template key": "declare const o: any\ndeclare const a: string\nconst v = o[`${a}`]",
    "computed destructuring": "declare const o: any\ndeclare const k: string\nconst { [k]: v } = o",
    "computed destructuring with a literal-typed key": 'declare const o: any\nconst k = "x" as const\nconst { [k]: v } = o',
    "import.meta computed": 'declare const k: "url"\nconst m = import.meta[k]',
    "prototype assignment": "Array.prototype.includes = () => true",
    "URL prototype": 'Object.defineProperty(URL.prototype, "origin", { get: () => "x" })',
  }
  const found = networkEach(Object.values(bypasses))
  expect(Object.keys(bypasses).filter((_, index) => found[index]!.length === 0)).toEqual([])
}, 60_000)

test("the network check allows the transport boundary, method calls on the connection API, comments, types and ordinary code", () => {
  const transport = 'const r = await fetch("https://x")\nawait integration.connection.resolve(c)\nimport https from "node:https"'
  expect(networkProblemsAll(repo, { "src/providers/openrouter/http.ts": transport })).toEqual({})
  // The boundary is that one file by name: the same text next to it is checked.
  expect(networkEach([transport], "src/providers/openrouter")[0]!.length).toBeGreaterThan(0)
  const ordinary = [
    "// the models fetch is off; the transport calls connection.resolve",
    "/** fetch */",
    "declare const integration: { connection: { active(id: string): Promise<unknown> } }",
    "const active = await integration.connection.active('x')",
    "declare const view: { connection: { state: string } }",
    "const ok = view.connection.state === 'connected'",
    "type Integration = { connection: unknown }",
    'type C = Pick<Integration, "connection">',
    "const p = new Promise((resolve) => resolve(1))",
    'import { join } from "node:path"',
    'import { createHash } from "node:crypto"',
    'import { InferenceError } from "../domain/errors.js"',
    "const self_ = 1",
    "const t = globalThis.structuredClone({})",
    "const env = process.env.HOME",
    "const pid = process.pid",
    "const list = [1, 2, 3]",
    "declare const index: number",
    "const n = list[index]",
    "const m = list[0]",
    'type Key = "a" | "b"',
    "declare const key: Key",
    "const record: Record<Key, number> = { a: 1, b: 2 }",
    "const v = record[key]",
  ].join("\n")
  expect(networkEach([ordinary])[0]).toEqual([])
}, 60_000)

test("the lint runs the network check on src/ and reports file and line", () => {
  const output = lint("src/host/x.ts", `const a = 1\nconst h = process.getBuiltinModule("node:https")\n`)
  expect(output).toContain("src/host/x.ts:2: module loader access outside the transport boundary: getBuiltinModule")
  expect(lint("src/providers/openrouter/http.ts", `await fetch("https://x")\n`)).not.toContain("network")
}, 60_000)

test("dist/ may hold only sections from src/ and the inlined packages", () => {
  const bundle = (section: string) => ["// src/index.ts", "var a = 1;", "// node_modules/zod/v4/core/core.js", "var z = 1;", section, "var b = 1;", "// @__NO_SIDE_EFFECTS__", ""].join("\n")
  const output = lintMany({
    "src/index.ts": "export {}\n",
    "dist/index.js": bundle("// scripts/zz-net.mjs"),
    "dist/tui.js": bundle("// node_modules/undici/index.js"),
  })
  expect(output).toContain("dist/index.js:5: bundles scripts/zz-net.mjs; dist/ holds only src/ and inlined zod")
  expect(output).toContain("dist/tui.js:5: bundles node_modules/undici/index.js")
  expect(output).not.toContain("bundles src/index.ts")
  expect(output).not.toContain("bundles node_modules/zod")
  for (const section of ["// test/support/network-spy.ts", "// ../outside.js"]) expect(lintMany({ "dist/index.js": bundle(section) })).toContain(`bundles ${section.slice(3)}`)
}, 120_000)
