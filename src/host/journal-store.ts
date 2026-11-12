import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, chmodSync, unlinkSync, writeSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { LockHeld, type JournalDocument, type JournalStore, type Owner } from "../runtime/journal.js"

// The journal's files: a private folder (0700) holding `journal.json` (0600) and, during a transaction only,
// `journal.lock`. The lock is an exclusive create (O_CREAT|O_EXCL) holding its owner's pid, host hash and a token. A
// held lock is waited for briefly and then refused with its owner's pid and liveness; it is never removed by anyone
// but its owner, so a crash while holding it needs a person to confirm and remove it. The journal is replaced
// atomically: written to a temporary file, flushed, renamed over the old one, and the folder flushed.

/** This process, for every journal it opens. */
export const OWNER: Owner = {
  pid: process.pid,
  host: createHash("sha256").update(hostname()).digest("hex").slice(0, 16),
  instance: randomUUID(),
}

/** The private state folder: $XDG_STATE_HOME/opencode-inference, or ~/.local/state/opencode-inference. */
export function stateRoot(env: NodeJS.ProcessEnv = process.env) {
  return join(env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state"), "opencode-inference")
}

/** One journal folder per connection label. The label is already a hash; it never contains the key. */
export const journalDirectory = (root: string, accountScope: string) => join(root, "journals", accountScope.replace(/[^a-z0-9]/g, "-"))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function liveness(owner: Pick<Owner, "pid" | "host">): "running" | "not_running" | "unknown" {
  if (owner.host !== OWNER.host) return "unknown"
  try {
    process.kill(owner.pid, 0)
    return "running"
  } catch (error) {
    const code = (error as { code?: string }).code
    return code === "ESRCH" ? "not_running" : code === "EPERM" ? "running" : "unknown"
  }
}

export interface StoreOptions {
  /** How long to wait for another process's transaction before refusing. Default 5 seconds. */
  readonly lockWaitMs?: number
}

const stores = new Map<string, JournalStore>()

/** The one store per journal folder in this process, so the process mutex covers every plugin instance using it. */
export function journalStore(directory: string): JournalStore {
  const store = stores.get(directory) ?? createJournalStore(directory)
  stores.set(directory, store)
  return store
}

export function createJournalStore(directory: string, options: StoreOptions = {}): JournalStore {
  const journal = join(directory, "journal.json")
  const lock = join(directory, "journal.lock")
  const wait = options.lockWaitMs ?? 5000

  const prepare = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if ((statSync(directory).mode & 0o077) !== 0) chmodSync(directory, 0o700)
  }

  const acquire = async () => {
    const token = randomUUID()
    const deadline = Date.now() + wait
    for (;;) {
      try {
        const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          writeSync(fd, JSON.stringify({ pid: OWNER.pid, host: OWNER.host, token, at: new Date().toISOString() }))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        return token
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error
      }
      if (Date.now() >= deadline) {
        // Refuse, never take over: even an owner that looks dead may be a reused pid or another container.
        let holder: { pid?: unknown; host?: unknown } = {}
        try {
          holder = JSON.parse(readFileSync(lock, "utf8")) as typeof holder
        } catch {
          // An empty or partial lock file: its owner is unknown.
        }
        const pid = typeof holder.pid === "number" && Number.isInteger(holder.pid) && holder.pid > 0 ? holder.pid : undefined
        const host = typeof holder.host === "string" ? holder.host : ""
        throw new LockHeld(lock, { ...(pid === undefined ? {} : { pid }), liveness: pid === undefined ? "unknown" : liveness({ pid, host }) })
      }
      await sleep(5 + Math.floor(Math.random() * 20))
    }
  }

  const release = (token: string) => {
    try {
      const holder = JSON.parse(readFileSync(lock, "utf8")) as { token?: string }
      if (holder.token === token) unlinkSync(lock)
    } catch {
      // Already gone, or not ours: leave it.
    }
  }

  const read = (): unknown => {
    let text: string
    try {
      text = readFileSync(journal, "utf8")
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined
      throw error
    }
    return JSON.parse(text) as unknown
  }

  const write = (document: JournalDocument) => {
    const temporary = `${journal}.${OWNER.instance}.tmp`
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
    try {
      writeSync(fd, JSON.stringify(document))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, journal)
    try {
      const folder = openSync(directory, constants.O_RDONLY)
      try {
        fsyncSync(folder)
      } finally {
        closeSync(folder)
      }
    } catch {
      // Some platforms cannot flush a folder; the rename itself is atomic.
    }
  }

  return {
    owner: OWNER,
    liveness,
    async transact(fn) {
      prepare()
      const token = await acquire()
      try {
        const { next, result } = fn(read())
        if (next) write(next)
        return result
      } finally {
        release(token)
      }
    },
  }
}
