import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = new URL("../../scripts/check-forbidden.mjs", import.meta.url).pathname

/** Runs a copy of the lint in a scratch git repo holding one source file, and returns its output. */
const lint = (path: string, content: string) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "forbidden-"))
  try {
    mkdirSync(join(dir, "scripts"))
    copyFileSync(script, join(dir, "scripts/check-forbidden.mjs"))
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true })
    writeFileSync(join(dir, path), content)
    execFileSync("git", ["init", "-q"], { cwd: dir })
    const run = spawnSync("node", ["scripts/check-forbidden.mjs"], { cwd: dir, encoding: "utf8" })
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
})

test("the lint allows fs in the host layer", () => {
  expect(lint("src/host/x.ts", `import { readFileSync } from "node:fs"\n`)).not.toContain("filesystem access")
})

test("the lint refuses every form of fetch outside the transport boundary, and allows it there", () => {
  for (const line of [
    `await fetch("https://x")`,
    `const f = globalThis.fetch`,
    `const { fetch } = globalThis`,
    `const f = globalThis["fetch"]`,
    `const ws = new WebSocket(url)`,
    `const s = Bun.connect({})`,
  ])
    for (const path of ["src/runtime/x.ts", "src/host/x.ts", "src/providers/openrouter/other.ts"]) expect(lint(path, `${line}\n`)).toContain("network access outside the transport boundary")
  expect(lint("src/providers/openrouter/http.ts", `await fetch("https://x")\n`)).not.toContain("network access")
  // A comment is not code.
  expect(lint("src/host/x.ts", `// the models fetch is off\n/** fetch */\n`)).not.toContain("network access")
}, 120_000)

test("the lint refuses network modules outside the transport boundary, bare or node:-prefixed", () => {
  for (const name of ["http", "https", "http2", "tls", "net", "dns", "dgram", "dns/promises", "undici"])
    for (const prefix of ["", "node:"]) {
      expect(lint("src/host/x.ts", `import x from "${prefix}${name}"\n`)).toContain("network module import outside the transport boundary")
      expect(lint("src/host/x.ts", `const x = await import("${prefix}${name}")\n`)).toContain("network module import outside the transport boundary")
      expect(lint("src/host/x.ts", `const x = require("${prefix}${name}")\n`)).toContain("network module import outside the transport boundary")
    }
  expect(lint("src/providers/openrouter/http.ts", `import https from "node:https"\n`)).not.toContain("network module")
  expect(lint("src/host/x.ts", `import { join } from "node:path"\nimport x from "./http.js"\n`)).not.toContain("network module")
}, 120_000)

test("the lint refuses connection.resolve in any form outside the transport boundary", () => {
  for (const line of [
    `await ctx.integration.connection.resolve(c)`,
    `const r = integration.connection.resolve`,
    `const r = connection?.resolve`,
    `const r = connection["resolve"]`,
    `const { resolve } = ctx.integration.connection`,
    `const { connection: { resolve } } = ctx.integration`,
  ])
    expect(lint("src/host/x.ts", `${line}\n`)).toContain("the OpenRouter key is resolved only at the transport boundary")
  expect(lint("src/providers/openrouter/http.ts", `await integration.connection.resolve(c)\n`)).not.toContain("resolved only")
  expect(lint("src/host/x.ts", `// the transport calls connection.resolve\nconst p = new Promise((resolve) => resolve(1))\n`)).not.toContain("resolved only")
}, 120_000)
