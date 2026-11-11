// Hosts the plugin on OpenCode through public packages only, in two ways:
// - startHost: the embedded host of @opencode/sdk (the dev pin, or the release in HOST_SDK_DIR) in this process, with
//   the plugin from src and an observer plugin that keeps each location's context, so a test can list the tools.
// - startStock: `opencode serve` of a stock release on a free loopback port with a password, loading an installed
//   package. Its HTTP(S) proxy refuses every request, and the models fetch, the update check and free models are off.
// Each host gets its own folder in one temp root under /tmp (never under the user's home: OpenCode searches upward for
// `.opencode/`), holding HOME, XDG_*, OPENCODE_TEST_HOME, TMPDIR, the config, the database and the project. Any fetch
// off loopback from this process fails the host's close.
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type AddressInfo, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode as Client, type OpenCodeClient } from "@opencode/client"
import { Plugin, type PluginOptions } from "@opencode/plugin"
import plugin from "../../src/index.js"
import { TESTED_HOSTS } from "../../src/host/versions.js"

export const REPO = fileURLToPath(new URL("../../", import.meta.url))
export const root = realpathSync(mkdtempSync(join(existsSync("/private/tmp") ? "/private/tmp" : "/tmp", "inference-host-")))

for (let parent = dirname(root); ; parent = dirname(parent)) {
  if (existsSync(join(parent, ".opencode"))) throw new Error(`The test isolation failed: ${join(parent, ".opencode")} is above the temp root ${root}.`)
  if (parent === dirname(parent)) break
}

const GIVEN_BINARIES = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OPENCODE_BIN_")))

export function isolatedEnv(home: string): Record<string, string> {
  const tmp = join(home, "tmp")
  mkdirSync(tmp, { recursive: true })
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_TEST_HOME: home,
    TMPDIR: tmp,
  }
}

function expectInsideRoot(what: string, paths: Readonly<Record<string, string | undefined>>) {
  const outside = Object.entries(paths).filter(([, path]) => !path?.startsWith(`${root}/`))
  if (outside.length > 0) throw new Error(`${what} must be inside ${root}, but ${outside.map(([name, path]) => `${name} is ${path}`).join(", ")}`)
}

for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE") || key.startsWith("OPENROUTER")) delete process.env[key]
Object.assign(process.env, isolatedEnv(join(root, "home")))
process.chdir(join(root, "home"))

const SDK = process.env.HOST_SDK_DIR ? join(realpathSync(process.env.HOST_SDK_DIR), "node_modules", "@opencode", "sdk") : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
export const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

/** Every fetch this process tried off loopback. The plugin must make none. */
export const offLoopback: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init)
    offLoopback.push(url.origin)
    return Promise.reject(new Error(`host test blocked a fetch to ${url.origin}`))
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch

export async function npm(args: string[], cwd: string) {
  const home = join(root, "npm")
  const run = Bun.spawn(["npm", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...isolatedEnv(home), npm_config_globalconfig: join(home, "npmrc"), npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(`npm ${args.join(" ")} failed (${code}):\n${stderr}`)
  return stdout
}

export interface HostInput {
  readonly options?: PluginOptions
  readonly config?: Record<string, unknown>
}

export interface Host {
  readonly client: OpenCodeClient
  readonly location: { readonly directory: string }
  /** The plugin context of the host's location, kept by the observer (embedded hosts only). */
  readonly context?: () => Plugin.Context | undefined
  /** How many times the plugin set up and cleaned up in this host (embedded hosts only). */
  readonly lifecycle?: { setups: number; cleanups: number }
  readonly log?: () => string
  close(): Promise<void>
}

const READY_MS = 180_000
/** Keeps the built-in local providers from probing ports, and turns on schedules, which run Code Mode unattended. */
const QUIET = {
  experimental: { schedules: true },
  providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
}

let hosts = 0
function hostFolder(name: string) {
  const base = join(root, `${name}-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  const git = spawnSync("git", ["init", "--quiet", work], { encoding: "utf8" })
  if (git.status !== 0) throw new Error(`git init ${work} failed: ${git.stderr || git.error?.message}`)
  return { base, work }
}
const servicePort = () => 20_000 + Math.floor(Math.random() * 20_000)

/** The embedded host with the plugin from src. */
export async function startHost(input: HostInput = {}): Promise<Host> {
  const { base, work } = hostFolder("host")
  const sources = ["HOME", "OPENCODE_TEST_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]
  expectInsideRoot("The embedded host's home, temp folder and working directory", { ...Object.fromEntries(sources.map((key) => [key, process.env[key]])), tmpdir: tmpdir(), cwd: process.cwd() })
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const contexts = new Map<string, Plugin.Context>()
  const lifecycle = { setups: 0, cleanups: 0 }
  const counted = Plugin.define({
    id: plugin.id,
    setup: async (ctx) => {
      const cleanup = await plugin.setup({ ...ctx, options: input.options ?? {} })
      lifecycle.setups++
      return async () => {
        await cleanup?.()
        lifecycle.cleanups++
      }
    },
  })
  const observer = Plugin.define({ id: "test.observer", setup: (ctx) => void contexts.set(realpathSync(ctx.location.directory), ctx) })
  const client = await OpenCode.create({
    plugins: [counted, observer],
    app: { version: HOST_VERSION },
    config: { content: JSON.stringify({ ...QUIET, ...input.config }), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })
  return ready({
    client: client as unknown as OpenCodeClient,
    location: { directory: work },
    context: () => contexts.get(realpathSync(work)),
    lifecycle,
    async close() {
      await client.close()
      if (offLoopback.length) throw new Error(`the host tried to leave loopback: ${[...new Set(offLoopback)].join(", ")}`)
    },
  })
}

export const STOCK_VERSIONS = TESTED_HOSTS
const binaries = new Map<string, Promise<string>>()
function stockBinary(version: string) {
  let binary = binaries.get(version)
  if (!binary) binaries.set(version, (binary = installStock(version)))
  return binary
}
async function installStock(version: string) {
  const given = GIVEN_BINARIES[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return realpathSync(given)
  const project = join(root, `opencode-${version}`)
  const name = `@opencode/cli-${process.platform}-${process.arch}`
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ private: true }))
  await npm(["install", "--ignore-scripts", `${name}@${version}`], project)
  return join(project, "node_modules", name, "bin", "opencode")
}

/** `opencode serve` of a stock release with the installed package directory `pkg` and extra user `config`. */
export async function startStock(version: string, pkg: string, config: Readonly<Record<string, unknown>> = {}): Promise<Host> {
  const binary = await stockBinary(version)
  const { base, work } = hostFolder(`stock-${version}`)
  const home = join(base, "home")
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ ...QUIET, ...config, plugins: [pkg] }, null, 2))
  writeFileSync(join(home, ".config", "opencode", "service.json"), JSON.stringify({ port: servicePort() }))
  const env = { ...isolatedEnv(home), PATH: "/usr/bin:/bin", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" }
  const run = (args: string[]) => spawnSync(binary, args, { cwd: work, env, encoding: "utf8" }).stdout
  const reported = /\d+\.\d+\.\d+\S*/.exec(run(["--version"]))?.[0]
  if (reported !== version) throw new Error(`${binary} reports OpenCode ${reported ?? "with no version"}, not ${version}`)
  const paths: Record<string, string | undefined> = { home: undefined, tmp: undefined }
  for (const line of run(["debug", "paths"]).split("\n")) {
    const match = /^(\S+)\s+(\S.*)$/.exec(line.trim())
    if (match) paths[match[1]!] = match[2]
  }
  expectInsideRoot(`\`opencode debug paths\` of ${version}`, paths)
  const proxy = await refusingProxy()
  const port = await freePort()
  const password = randomBytes(18).toString("base64url")
  const log = createWriteStream(join(base, "serve.log"))
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"], {
    cwd: work,
    env: { ...env, OPENCODE_PASSWORD: password, ...proxyEnv(proxy.url) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const client = Client.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  const close = async () => {
    child.kill("SIGTERM")
    await Promise.race([exited, Bun.sleep(10_000).then(() => child.kill("SIGKILL"))])
    await proxy.close()
  }
  try {
    await until(`opencode serve answers on port ${port}`, () => client.server.info().then(() => true, () => false), READY_MS)
  } catch (error) {
    await close()
    throw new Error(`${(error as Error).message}\n${readFileSync(join(base, "serve.log"), "utf8").slice(-2000)}`)
  }
  return ready({ client, location: { directory: work }, log: () => readFileSync(join(base, "serve.log"), "utf8"), close })
}

/** Waits until the plugin is active, and closes the host if it never is. */
async function ready(host: Host): Promise<Host> {
  let seen = "nothing yet"
  try {
    expectInsideRoot("OpenCode's temp folder", { tmp: (await host.client.server.info()).paths.tmp })
    await until(
      "the Inference plugin is active",
      async () => {
        const { data: plugins } = await host.client.plugin.list({ location: host.location })
        const state = plugins.find((entry) => entry.id === plugin.id)?.state
        if (state?.status === "failed") throw new Error(`the Inference plugin failed: ${state.error}`)
        seen = `plugin ${state?.status ?? "not listed"}`
        return state?.status === "active"
      },
      READY_MS,
    )
  } catch (error) {
    await host.close().catch(() => {})
    throw new Error(`${(error as Error).message} (last seen: ${seen})`)
  }
  return host
}

const proxyEnv = (url: string) => ({ HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" })

async function refusingProxy() {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"))
    socket.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const close = () => new Promise<void>((resolve) => (sockets.forEach((socket) => socket.destroy()), server.close(() => resolve())))
  return { url: `http://127.0.0.1:${port}`, close }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}

export function cleanup() {
  rmSync(root, { recursive: true, force: true })
}
