import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { FileProblem, type FileAccess, type FileIdentity, type Inspection } from "../runtime/sources.js"

// The file system side of src/runtime/sources.ts: metadata before approval, a descriptor read after it. Nothing here
// decides policy; it reports what it found, and the runtime refuses.

const identityOf = (stats: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): FileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
})

const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const missing = (error: unknown) => typeof error === "object" && error !== null && ["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown }).code))

/** O_NOFOLLOW refuses a final symbolic link at open; O_NONBLOCK keeps a FIFO from blocking the open. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0)

export const files: FileAccess = {
  async inspect(path, roots): Promise<Inspection> {
    let stats
    try {
      stats = await lstat(path, { bigint: true })
    } catch (error) {
      if (missing(error)) return { kind: "missing", linkedWithinRoot: false }
      throw new FileProblem("unreadable")
    }
    if (stats.isSymbolicLink()) return { kind: "symlink", linkedWithinRoot: false }
    if (!stats.isFile()) return { kind: "other", linkedWithinRoot: false }
    // Inside a root, the real location must be the named one: no component between the root and the file may be a
    // symbolic link. Outside the project, the host's external_directory approval covers the named directory.
    let linkedWithinRoot = false
    const parent = await realpath(dirname(path)).catch(() => undefined)
    for (const root of roots) {
      if (!within(root, path)) continue
      const realRoot = await realpath(root).catch(() => undefined)
      if (parent === undefined || realRoot === undefined || join(parent, basename(path)) !== join(realRoot, relative(root, path))) linkedWithinRoot = true
    }
    return { kind: "file", linkedWithinRoot, identity: identityOf(stats) }
  },

  async read(path, expected, maxBytes) {
    let handle
    try {
      handle = await open(path, READ_FLAGS)
    } catch (error) {
      const code = String((error as { code?: unknown }).code)
      if (code === "ELOOP" || code === "EMLINK") throw new FileProblem("symlink")
      if (missing(error)) throw new FileProblem("missing")
      throw new FileProblem("unreadable")
    }
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) throw new FileProblem("not_regular")
      if (!same(identityOf(before), expected)) throw new FileProblem("changed")
      if (before.size > BigInt(maxBytes)) throw new FileProblem("too_large")
      const size = Number(before.size)
      // One spare byte shows a file that grew after the stat.
      const buffer = new Uint8Array(size + 1)
      let filled = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
        if (filled === buffer.byteLength) break
      }
      if (filled !== size) throw new FileProblem("changed")
      const after = await handle.stat({ bigint: true })
      if (!same(identityOf(after), expected)) throw new FileProblem("changed")
      return buffer.subarray(0, size)
    } finally {
      await handle.close().catch(() => undefined)
    }
  },
}
