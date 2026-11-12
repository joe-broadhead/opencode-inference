import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = new URL("../../scripts/check-forbidden.mjs", import.meta.url).pathname
const { networkProblems } = (await import(new URL("../../scripts/check-network.mjs", import.meta.url).href as string)) as {
  networkProblems: (file: string, text: string) => [number, string][]
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

/** The network check's messages for one source text. */
const network = (text: string, file = "src/host/x.ts") => networkProblems(file, text).map(([, message]) => message)

test("the lint refuses fs imports in the domain and the runtime", () => {
  for (const specifier of ["node:fs", "fs", "node:fs/promises", "fs/promises"]) {
    for (const path of ["src/domain/x.ts", "src/runtime/x.ts"]) {
      expect(lint(path, `import { readFileSync } from "${specifier}"\n`)).toContain("filesystem access in the domain or runtime")
    }
  }
})

test("the lint allows fs in the host layer", () => {
  expect(lint("src/host/x.ts", `import { readFileSync } from "node:fs"\n`)).not.toContain("filesystem access")
})

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

test("modules are an allow-list: relative paths, the listed node: builtins and the listed packages, in every import form", () => {
  const refused = ["http", "https", "http2", "net", "tls", "dns", "dns/promises", "dgram", "undici", "child_process", "worker_threads", "module", "vm", "process", "util", "fs", "path", "_http_client", "_tls_wrap"]
  for (const name of [...refused.map((name) => `node:${name}`).filter((name) => !["node:fs", "node:path"].includes(name)), ...refused, "bun", "bun:ffi", "got", "@opencode/client"])
    for (const form of [`import x from "${name}"`, `export * from "${name}"`, `const x = await import("${name}")`, `const x = require("${name}")`, `import x = require("${name}")`, `type T = typeof import("${name}")`])
      expect(network(form)).toContain(`a module outside the allow-list: ${name}`)
  for (const name of ["node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:url", "zod", "@opencode/plugin", "@opencode/plugin/rpc", "solid-js", "./x.js", "../domain/ids.js"])
    for (const form of [`import x from "${name}"`, `export * from "${name}"`, `const x = await import("${name}")`])
      expect(network(form)).toEqual([])
})

test("the current src/ passes the network check unchanged", () => {
  const files = execFileSync("git", ["ls-files", "src"], { cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8" }).split("\n").filter(Boolean)
  const problems = files.flatMap((file) => networkProblems(file, readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")).map(([line, message]) => `${file}:${line}: ${message}`))
  expect(problems).toEqual([])
})

test("the network check refuses every network global, however it is reached", () => {
  for (const text of [`await fetch("https://x")`, "const f = globalThis.fetch", "const { fetch } = globalThis", 'const f = globalThis["fetch"]', "new WebSocket(u)", "new XMLHttpRequest()", "new EventSource(u)", "Bun.spawn(['curl'])"])
    expect(network(text).length).toBeGreaterThan(0)
})

test("the network check allows the transport boundary, method calls on the connection API, comments, types and ordinary code", () => {
  expect(network('const r = await fetch("https://x")\nawait integration.connection.resolve(c)\nimport https from "node:https"', "src/providers/openrouter/http.ts")).toEqual([])
  expect(
    network(
      [
        "// the models fetch is off; the transport calls connection.resolve",
        "/** fetch */",
        "const active = await integration.connection.active(ID)",
        "const ok = view.connection.state === 'connected'",
        "type C = Pick<Integration, \"connection\">",
        "const p = new Promise((resolve) => resolve(1))",
        'import { join } from "node:path"',
        'import { createHash } from "node:crypto"',
        'import x from "./http.js"',
        "const self_ = 1",
        "const t = globalThis.structuredClone(x)",
        "const env = process.env.HOME",
        "const v = record[key]",
      ].join("\n"),
    ),
  ).toEqual([])
})

test("the lint runs the network check on src/ and reports file and line", () => {
  const output = lint("src/host/x.ts", `const a = 1\nconst h = process.getBuiltinModule("node:https")\n`)
  expect(output).toContain("src/host/x.ts:2: module loader access outside the transport boundary: getBuiltinModule")
  expect(lint("src/providers/openrouter/http.ts", `await fetch("https://x")\n`)).not.toContain("network")
}, 60_000)
