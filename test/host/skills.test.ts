// The built plugin's skills on a real stock OpenCode 2.4.1 server: the plugin registers them through
// `ctx.skill.transform`, and the server's `GET /api/skill` returns every `skills/*/SKILL.md` id. The test spawns
// `opencode serve` in an isolated home and is part of `npm run test:host` (and so `npm run check`).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  execFileSync("git", ["init", "-q", work])
  writeFileSync(join(work, "README.md"), "# skill host\n")
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

test("the real server returns every shipped skill id from GET /api/skill", async () => {
  const answer = await host!.client.skill.list({ location: { directory: host!.work } })
  const ids = answer.data.map((skill) => skill.id).filter((id) => id.startsWith("inference")).sort()
  expect(ids).toEqual(shipped)
  expect(ids).toEqual(["inference", "inference-decide", "inference-extract"])
  // The registration carries the authored description and body, not an empty placeholder.
  for (const skill of answer.data.filter((entry) => entry.id.startsWith("inference"))) {
    expect(skill.description?.length).toBeGreaterThan(20)
    expect(skill.content.length).toBeGreaterThan(20)
  }
  // The status command is registered in the same setup and is listed by the real server.
  const commands = await host!.client.command.list({ location: { directory: host!.work } })
  expect(commands.data.map((command) => command.name)).toContain("inference")
})
