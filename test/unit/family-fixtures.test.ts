// The vendored Jobs and Utilities plugins are exactly the released files: every one listed in FILES.sha256 with its
// digest, none missing, none extra. A changed byte, a missing file or an added one is caught.
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { familyProblems } from "../support/family.js"
import { tempRoot } from "../support/temp.js"

const FAMILY = fileURLToPath(new URL("../fixtures/family/", import.meta.url))

test("each vendored plugin matches its committed digests, with its licence, and the README records the Release digests", () => {
  for (const name of ["jobs@0.0.0", "utilities@0.0.0"]) {
    expect({ name, problems: familyProblems(join(FAMILY, name)) }).toEqual({ name, problems: [] })
    expect(readFileSync(join(FAMILY, name, "LICENSE"), "utf8")).toContain("MIT License")
  }
  const readme = readFileSync(join(FAMILY, "README.md"), "utf8")
  for (const digest of ["1a341a55bf190143c821c1b1f5520da02da601175cb8646852a95af3c1230cc7", "d49fd0e5832aafb1c98f21d755348537e9fc0fc660ee3ad74220654a2ed6c2d9"]) expect(readme).toContain(digest)
})

test("every vendored file is tracked by git, so a clean checkout has it (a dist/ ignore rule must not drop one)", () => {
  const repo = fileURLToPath(new URL("../../", import.meta.url))
  const tracked = new Set(spawnSync("git", ["ls-files", "-z", "test/fixtures/family"], { cwd: repo, encoding: "utf8" }).stdout.split("\0").filter(Boolean))
  for (const name of ["jobs@0.0.0", "utilities@0.0.0"]) {
    const listed = readFileSync(join(FAMILY, name, "FILES.sha256"), "utf8").trim().split("\n").map((line) => line.slice(66))
    for (const path of [...listed, "FILES.sha256"]) {
      const file = `test/fixtures/family/${name}/${path}`
      expect({ file, tracked: tracked.has(file) }).toEqual({ file, tracked: true })
    }
  }
})

test("a changed byte, a missing file and an unlisted file are each refused", () => {
  const copy = join(tempRoot("family"), "jobs")
  cpSync(join(FAMILY, "jobs@0.0.0"), copy, { recursive: true })
  appendFileSync(join(copy, "dist", "index.js"), "\n// changed")
  rmSync(join(copy, "NOTICE"))
  writeFileSync(join(copy, "dist", "extra.js"), "export {}")
  expect(familyProblems(copy).sort()).toEqual(["NOTICE is missing", "dist/extra.js is not listed", "dist/index.js does not match its SHA-256"])
})
