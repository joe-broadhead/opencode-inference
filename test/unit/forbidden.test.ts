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
