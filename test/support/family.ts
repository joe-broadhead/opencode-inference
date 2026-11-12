// The vendored family plugins' integrity check (test/fixtures/family/README.md). No side effects: unit tests import it.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * Checks a vendored plugin folder against its committed FILES.sha256: every listed file present with its digest, and no
 * file that is not listed. Returns the problems; empty means it is exactly what was released.
 */
export function familyProblems(dir: string): string[] {
  const listed = new Map(
    readFileSync(join(dir, "FILES.sha256"), "utf8")
      .trim()
      .split("\n")
      .map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[2]!, match[1]!] as const),
  )
  const present = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .filter((path) => path !== "FILES.sha256")
  const problems = present.filter((path) => !listed.has(path)).map((path) => `${path} is not listed`)
  for (const [path, digest] of listed) {
    if (!existsSync(join(dir, path))) problems.push(`${path} is missing`)
    else if (createHash("sha256").update(readFileSync(join(dir, path))).digest("hex") !== digest) problems.push(`${path} does not match its SHA-256`)
  }
  return problems
}
