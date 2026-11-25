// The built plugin's skills on a real stock OpenCode 2.4.1 server: the plugin registers them through
// `ctx.skill.transform`, and the server's `GET /api/skill` returns every `skills/*/SKILL.md` id. The test spawns
// `opencode serve` in an isolated home and is part of `npm run test:host` (and so `npm run check`).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { OpenCode } from "@opencode/client"

setDefaultTimeout(180_000)
const VERSION = "2.4.1"
const PLUGIN_DIR = resolve(import.meta.dir, "..", "..")
const BIN = process.env["OPENCODE_BIN_2_4_1"] ?? "/usr/local/bin/opencode"

/** Every skill id the package ships, from the files themselves. */
const shipped = readdirSync(join(PLUGIN_DIR, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

/** The YAML front matter of one SKILL.md, parsed by Bun's YAML parser. */
function frontMatter(file: string): Record<string, unknown> {
  const text = readFileSync(file, "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (match === null) throw new Error(`no front matter: ${file}`)
  const parsed = Bun.YAML.parse(match[1]!)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`front matter is not a mapping: ${file}`)
  return parsed as Record<string, unknown>
}

interface Host {
  readonly client: ReturnType<typeof OpenCode.make>
  readonly work: string
  readonly root: string
  readonly server: ChildProcess
  readonly log: () => string
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })
}

async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(250)
  }
}

async function start(): Promise<Host> {
  const version = execFileSync(BIN, ["--version"], { encoding: "utf8" }).trim()
  if (!version.includes(VERSION)) throw new Error(`${BIN} reports ${version}, not OpenCode ${VERSION}`)
  const root = mkdtempSync(join(tmpdir(), "inference-skills-"))
  const home = join(root, "home")
  const work = join(root, "work")
  for (const directory of [join(home, ".config", "opencode"), join(home, ".local", "share"), join(home, ".cache"), join(home, ".local", "state"), join(root, "tmp"), work]) mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ plugins: [PLUGIN_DIR], providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } } }, null, 2),
  )
  const port = await freePort()
  const password = randomBytes(18).toString("base64url")
  const log = join(root, "serve.log")
  const server = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"], {
    cwd: work,
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      TMPDIR: join(root, "tmp"),
      OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const read = () => {
    try {
      return readFileSync(log, "utf8")
    } catch {
      return ""
    }
  }
  const output = { text: "" }
  server.stdout?.on("data", (chunk: Buffer) => (output.text += chunk.toString("utf8")))
  server.stderr?.on("data", (chunk: Buffer) => (output.text += chunk.toString("utf8")))
  const writeLog = () => writeFileSync(log, output.text)
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  const host: Host = { client, work, root, server, log: () => (writeLog(), read()) }
  try {
    await until("the OpenCode server answers", async () => {
      try {
        await client.server.info()
        return true
      } catch {
        if (server.exitCode !== null) throw new Error(`opencode serve exited ${server.exitCode}: ${host.log().slice(-2000)}`)
        return false
      }
    })
    await until("the Inference plugin is active", async () => {
      const list = await client.plugin.list({ location: { directory: work } })
      const entry = list.data.find((plugin) => plugin.id === "inference")
      if (entry?.state.status === "failed") throw new Error(`the Inference plugin failed: ${entry.state.error}\n${host.log().slice(-2000)}`)
      return entry?.state.status === "active"
    })
    return host
  } catch (error) {
    await close(host)
    throw error
  }
}

async function close(host: Host | undefined) {
  if (host === undefined) return
  host.server.kill("SIGTERM")
  await Promise.race([new Promise((resolve) => host.server.once("exit", resolve)), Bun.sleep(10_000)])
  if (host.server.exitCode === null) host.server.kill("SIGKILL")
  rmSync(host.root, { recursive: true, force: true })
}

let host: Host | undefined
beforeAll(async () => {
  host = await start()
})
afterAll(async () => {
  await close(host)
})

test("the real server returns every shipped skill with the description its SKILL.md declares", async () => {
  // The project is a separate temp directory with no skills/ of its own: a pass cannot come from project discovery.
  expect(host!.work).not.toBe(PLUGIN_DIR)
  expect(readdirSync(host!.work).includes("skills")).toBe(false)
  const answer = await host!.client.skill.list({ location: { directory: host!.work } })
  const registered = answer.data.filter((skill) => shipped.includes(skill.id)).sort((left, right) => left.id.localeCompare(right.id))
  expect(registered.map((skill) => skill.id)).toEqual(shipped)
  expect(registered.map((skill) => skill.id)).toEqual(["inference", "inference-decide", "inference-extract"])
  for (const skill of registered) {
    const file = join(PLUGIN_DIR, "skills", skill.id, "SKILL.md")
    expect(existsSync(file)).toBe(true)
    const parsed = frontMatter(file)
    const description = parsed["description"]
    expect(parsed["name"]).toBe(skill.id)
    expect(typeof description).toBe("string")
    const declared = description as string
    expect(declared.trim()).not.toBe("")
    expect(declared).not.toBe(">")
    expect(declared).not.toBe("|")
    expect(declared.startsWith(">")).toBe(false)
    expect(declared.startsWith("|")).toBe(false)
    expect(skill.description).toBe(declared)
    expect(skill.name).toBe(skill.id)
    expect(skill.path.endsWith(join("skills", skill.id, "SKILL.md"))).toBe(true)
    expect(skill.content.length).toBeGreaterThan(20)
  }
  // The status command is registered in the same setup and is listed by the real server.
  const commands = await host!.client.command.list({ location: { directory: host!.work } })
  expect(commands.data.map((command) => command.name)).toContain("inference")
})
