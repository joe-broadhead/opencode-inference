// The network and key boundary over the whole of src/: no network module or global, no loader escape, no computed key
// that could name one, and no reach into the host's connection API except a direct method call. The transport file is
// the one exception, and it is where the key is resolved.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
// @ts-expect-error the boundary check is plain JavaScript, run as-is
import { networkProblemsAll } from "../../scripts/check-network.mjs"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

function walk(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : /\.(?:ts|tsx)$/.test(entry.name) ? [join(directory, entry.name)] : [],
  )
}

test("src/ stays inside the network and key boundary", () => {
  const files = Object.fromEntries(walk("src").map((file) => [relative(ROOT, join(ROOT, file)).split("\\").join("/"), readFileSync(join(ROOT, file), "utf8")]))
  expect(Object.keys(files).length).toBeGreaterThan(10)
  const problems = networkProblemsAll(ROOT, files) as Record<string, [number, string][]>
  const found = Object.entries(problems).flatMap(([file, list]) => list.map(([line, message]) => `${file}:${line} ${message}`))
  expect(found).toEqual([])
}, 10_000)
