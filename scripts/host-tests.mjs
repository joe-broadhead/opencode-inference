// The host suite on the tested OpenCode release (TESTED_HOSTS in src/host/versions.ts): this checkout's locked
// @opencode/sdk. A release that does not run, or fails, fails this stage.
//   node scripts/host-tests.mjs
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = { ...process.env, PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` }
const { TESTED_HOSTS } = await import(new URL("../src/host/versions.ts", import.meta.url).href)
const SDK_PIN = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@opencode/sdk"]

const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: "inherit", env }).status ?? 1

const missing = TESTED_HOSTS.filter((version) => version !== SDK_PIN)
if (missing.length > 0) {
  console.error(`[host] FAILED: @opencode/sdk is ${SDK_PIN}, so no host suite runs on ${missing.join(", ")}.`)
  process.exit(1)
}

console.log(`\n[host] @opencode/sdk ${SDK_PIN} (the dev pin, this checkout's copy)`)
process.exit(run("bun", ["test", "./test/host"]))
