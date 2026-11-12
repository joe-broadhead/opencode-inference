// Fails when the repository or the built dist/ uses something this plugin must never use: fork-only or legacy
// host APIs, the removed permission policy layer, install scripts, host peers, absolute local paths, or
// host-provided or build-time code bundled into dist/. Run it after the build; `npm run check` does.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { networkProblemsAll } from "./check-network.mjs"

// FORBIDDEN_ROOT lets the lint's own tests run this script on a scratch repository.
const root = process.env.FORBIDDEN_ROOT ? join(process.env.FORBIDDEN_ROOT, "/") : fileURLToPath(new URL("../", import.meta.url))
const self = relative(root, fileURLToPath(import.meta.url))
const problems = []
const report = (file, line, message) => problems.push(`${file}${line ? `:${line}` : ""}: ${message}`)

const walk = dir => existsSync(join(root, dir))
  ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => relative(root, join(e.parentPath, e.name)))
  : []
// Tracked files plus new files that are not ignored, so the scan sees work before it is committed.
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(file => file && file !== self && existsSync(join(root, file)))
const text = file => {
  const bytes = readFileSync(join(root, file))
  return bytes.subarray(0, 8192).includes(0) ? undefined : bytes.toString("utf8")
}
const code = /\.(?:[cm]?[jt]s|tsx)$/
// Vendored release files (test/fixtures/family/, each checked against its committed FILES.sha256 by the tests) are not
// first-party code: the rules below are for this repository's own source.
const VENDORED = /^test\/fixtures\/family\//
const source = tracked.filter(file => code.test(file) && /^(?:src|test|scripts)\//.test(file) && !VENDORED.test(file))
const dist = walk("dist")
const built = dist.filter(file => /\.js$/.test(file))

/** Line rules for first-party code. `scope` limits a rule to paths that start with one of its prefixes. */
const RULES = [
  { pattern: /["']@opencode-ai\//, message: "V1 @opencode-ai packages" },
  { pattern: /["'`]@opencode\/ai(?:\/[^"'`]*)?["'`]/, message: "@opencode/ai changes incompatibly between patches; do not import it" },
  { pattern: /\bpackages\/(?:ai|client|core|opencode|plugin|protocol|schema|sdk|server|util)\/src\b/, message: "private host source import" },
  { pattern: /\bhook\(\s*["']evaluate["']/, evaluate: true, message: "permission evaluate hook (only the tools RPC's own, in src/host/tools-rpc.ts)" },
  { pattern: /\bevent\.effect\s*=(?!=)/, message: "a hook that changes a permission effect" },
  { pattern: /\b(?:config|options)\.policy\b|(?:^|[\s{,])policy\s*\??\s*:/, scope: ["src/", "dist/"], message: "plugin permission policy option" },
  { pattern: /\bexperimental\s*\??\.\s*artifact\b|\bexperimental\s*\??\.?\[\s*["'`]artifact["'`]\s*\]|\{[^}]*\bartifact\b[^}]*\}\s*=\s*[\w$.?]*\bexperimental\b/, message: "ctx.experimental.artifact is experimental (new in 2.2.4); do not use it" },
  { pattern: /^import\s+\{[^}]*\bz\b[^}]*\}\s+from\s+["']zod["']/, scope: ["src/"], message: "import zod as `import * as z from \"zod\"`; a named import bundles every locale" },
  // The network and key boundary is checked on the syntax tree, in scripts/check-network.mjs, below.
  // The domain and the runtime are pure: the filesystem is the host layer's business.
  { pattern: /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](?:node:)?fs(?:\/promises)?["']/, scope: ["src/domain/", "src/runtime/"], message: "filesystem access in the domain or runtime; keep fs in src/host/" },
]
// The one exception to the evaluate-hook rule: the tools RPC (src/host/tools-rpc.ts) turns an ask on its own script
// calls in flight into a deny, because no one is there to answer a script's prompt. It only tightens, and matches only
// its own live call ids. It is allowed exactly once, in that file and in that file's section of dist/index.js.
const SCRIPT_HOOK = "src/host/tools-rpc.ts"
const scriptHooks = new Map([[SCRIPT_HOOK, 0], ["dist/index.js", 0]])
const vendored = file => file.startsWith("dist/")
for (const file of [...source, ...built]) {
  const content = readFileSync(join(root, file), "utf8")
  // In dist/, only first-party sections are checked; the bundler marks each bundled module with a `// <path>` comment.
  let firstParty = true, section = file
  content.split("\n").forEach((line, index) => {
    if (vendored(file) && /^\/\/ (?:src|node_modules)\//.test(line)) { firstParty = line.startsWith("// src/"); section = line.slice(3) }
    if (!firstParty) return
    for (const rule of RULES) {
      if (rule.scope && !rule.scope.some(prefix => file.startsWith(prefix))) continue
      if (rule.except && rule.except.test(file)) continue
      if (!rule.pattern.test(line)) continue
      if (rule.evaluate && section === SCRIPT_HOOK && scriptHooks.has(file)) { scriptHooks.set(file, scriptHooks.get(file) + 1); continue }
      report(file, index + 1, rule.message)
    }
  })
  for (const call of assertCalls(content)) if (call.args > 1) report(file, call.line, "permission.assert takes one argument; the signal option is fork-only")
}
// The network and key boundary, on the syntax tree of every first-party source file.
{
  const files = Object.fromEntries(source.filter(file => file.startsWith("src/")).map(file => [file, readFileSync(join(root, file), "utf8")]))
  for (const [file, found] of Object.entries(networkProblemsAll(root.replace(/\/$/, ""), files))) for (const [line, message] of found) report(file, line, message)
}

for (const [file, count] of scriptHooks) if (count !== 1) report(file, 0, `the tools RPC's evaluate hook must appear exactly once here, found ${count}`)

/** `.assert(` calls with their top-level argument count, skipping strings and comments. */
function assertCalls(content) {
  const calls = []
  for (const match of content.matchAll(/\.assert\s*\(/g)) {
    let depth = 0, args = 0, seen = false, quote = ""
    for (let i = match.index + match[0].length - 1; i < content.length; i++) {
      const c = content[i]
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue }
      if (c === "\"" || c === "'" || c === "`") { quote = c; seen = true; continue }
      if (c === "/" && content[i + 1] === "/") { i = content.indexOf("\n", i); if (i < 0) break; continue }
      if (c === "/" && content[i + 1] === "*") { i = content.indexOf("*/", i + 2) + 1; if (i <= 0) break; continue }
      if ("([{".includes(c)) { depth++; if (depth > 1) seen = true; continue }
      if (")]}".includes(c)) { if (--depth === 0) break; continue }
      if (depth === 1 && c === ",") { args++; seen = false; continue }
      if (depth === 1 && !/\s/.test(c)) seen = true
    }
    calls.push({ line: content.slice(0, match.index).split("\n").length, args: args + (seen ? 1 : 0) })
  }
  return calls
}

// Package manifests: no install-time or pack-time scripts, and no peers or bundled dependencies.
const LIFECYCLE = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare", "prepublish", "prepack", "postpack"]
for (const file of tracked.filter(file => file === "package.json")) {
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8"))
  for (const name of LIFECYCLE) if (manifest.scripts?.[name] !== undefined) report(file, 0, `"${name}" script runs on install or pack; OpenCode installs with scripts disabled`)
  for (const field of ["peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies"]) if (manifest[field] !== undefined) report(file, 0, `"${field}": the host provides @opencode/plugin, OpenTUI and Solid, so packages declare no peers and bundle nothing`)
}

// Absolute local paths in anything tracked, and in dist/.
const ABSOLUTE = /\/Users\/[A-Za-z]|\/home\/[a-z][\w.-]*\/|\/private\/var\/folders\/|\/var\/folders\/[a-z0-9_]{2}\/|[A-Z]:\\Users\\/
for (const file of [...tracked, ...dist]) {
  const content = text(file)
  if (content === undefined) continue
  content.split("\n").forEach((line, index) => { if (ABSOLUTE.test(line)) report(file, index + 1, "absolute local path") })
}

// dist/ ships prebuilt JavaScript only, and inlines no host-provided or build-time package.
const INLINED = new Set(["zod"])
if (built.length === 0) report("dist", 0, "missing; run npm run build first")
for (const file of dist) if (!file.endsWith(".js")) report(file, 0, "dist/ ships only .js; the licences of inlined packages are in the root NOTICE")
// Every bundled section is either first-party source under src/ or an inlined package: a section from scripts/, test/,
// a parent folder or any other package fails, so a relative import cannot smuggle code past the source checks.
for (const file of built) {
  readFileSync(join(root, file), "utf8").split("\n").forEach((line, index) => {
    const section = /^\/\/ ([^\s@][^\s]*\.(?:[cm]?[jt]sx?|json))$/.exec(line)?.[1]
    if (section === undefined) return
    const inlined = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(section)?.[1]
    if (!section.startsWith("src/") && !(inlined !== undefined && INLINED.has(inlined))) report(file, index + 1, `bundles ${section}; dist/ holds only src/ and inlined ${[...INLINED].join(", ")}`)
  })
}
for (const file of built) {
  const packages = new Set([...readFileSync(join(root, file), "utf8").matchAll(/^\/\/ node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gm)].map(m => m[1]))
  for (const name of packages) if (!INLINED.has(name)) report(file, 0, `bundles ${name}; host-provided and build-time packages stay external or out of dist/`)
}

if (problems.length) {
  console.error(`check-forbidden: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n${problems.map(p => `  ${p}`).join("\n")}`)
  process.exit(1)
}
console.log(`check-forbidden: clean (${source.length} source files, ${built.length} built files, ${tracked.length} tracked files)`)

// The family's working folders and the owner's private names never reach a public file. This reads every git-tracked
// file, so a note in a doc, a skill or a fixture is caught as well as code. AGENTS.md and this script name them on
// purpose and are skipped. Case does not matter.
{
  const { realpathSync, existsSync, readFileSync } = await import("node:fs")
  const { execFileSync } = await import("node:child_process")
  const { join, dirname } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const WORDS = /opencode-release\/|prosus|toqan/i
  const self = realpathSync(fileURLToPath(import.meta.url))
  if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
    const repo = join(dirname(self), "..")
    let listed = []
    try {
      listed = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean)
    } catch {
      // Not a git checkout, such as a packed tarball: the scan above covers the shipped files.
    }
    const hits = []
    for (const path of listed) {
      if (path === "AGENTS.md" || path === "scripts/check-forbidden.mjs") continue
      const file = join(repo, path)
      if (!existsSync(file)) continue
      const buffer = readFileSync(file)
      if (buffer.includes(0)) continue
      buffer.toString("utf8").split(/\r?\n/).forEach((text, index) => {
        if (WORDS.test(text)) hits.push(`${path}:${index + 1}`)
      })
    }
    if (hits.length) {
      console.error(`forbidden-words: the family's working folders and the owner's private names must not appear in a public file:\n  ${hits.join("\n  ")}`)
      process.exitCode = 1
    }
  }
}
