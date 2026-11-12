import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type * as z from "zod"
import type { SourceInput } from "../domain/contracts.js"
import { fence, InferenceError } from "../domain/errors.js"
import { modalityOf } from "../domain/routing.js"
import type { RouteCapability } from "../providers/openrouter/capabilities.js"

// Sources (handoff §5.1, §7 steps 2 and 5). The order is the guarantee:
//
// 1. `locate` identifies the source from its descriptor and file METADATA only (lstat and the parent's real path): no
//    byte of the file is read, no MIME is sniffed and nothing is hashed. It refuses unsafe paths and foreign
//    artifacts here, before anyone is asked.
// 2. The caller asserts `permissionRequests(located)` with the host (read, and external_directory outside the project).
// 3. `snapshot` opens the file through a descriptor without following a final symbolic link, checks the open file is
//    the same file that was approved (device, inode, size, change times), reads at most the byte limit, determines the
//    type from the bytes, hashes them and keeps a private copy. A file replaced, grown or touched in between is refused.
//
// The file system itself is the host layer's (src/host/files.ts implements `FileAccess`); this module holds the policy.

type Source = z.infer<typeof SourceInput>

/** The hard ceiling on one source, whatever a route documents. */
export const SOURCE_MAX_BYTES = 16 * 1024 * 1024

/** What identifies a file between approval and reading. */
export interface FileIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

export interface Inspection {
  /** `symlink` when the final component is a symbolic link; `other` for a directory, device, FIFO or socket. */
  readonly kind: "file" | "symlink" | "other" | "missing"
  /** True when a component between `root` and the file is a symbolic link (only checked for a path inside `root`). */
  readonly linkedWithinRoot: boolean
  readonly identity?: FileIdentity
}

/** Why the host could not hand over the approved bytes. */
export class FileProblem extends Error {
  constructor(readonly kind: "missing" | "symlink" | "not_regular" | "changed" | "too_large" | "unreadable") {
    super(kind)
    this.name = "FileProblem"
  }
}

/** The host's file access: metadata before approval, descriptor reads after. Implemented in src/host/files.ts. */
export interface FileAccess {
  /** Metadata only. Never opens the file. */
  inspect(path: string, roots: readonly string[]): Promise<Inspection>
  /**
   * Opens `path` without following a final symbolic link, verifies the descriptor is `expected`, and returns at most
   * `maxBytes` bytes. Throws FileProblem when the file changed, grew past the limit or is not a regular file.
   */
  read(path: string, expected: FileIdentity, maxBytes: number): Promise<Uint8Array>
}

export interface Project {
  readonly id: string
  /** The location's directory: relative paths resolve against it. */
  readonly directory: string
  /** The project's (worktree's) directory. A path inside either is internal. */
  readonly worktree: string
}

export interface PermissionRequest {
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[]
}

/** A source identified but not yet read. */
export type Located =
  | { readonly kind: "text"; readonly text: string; readonly label?: string }
  | {
      readonly kind: "file"
      readonly absolute: string
      readonly internal: boolean
      readonly resource: string
      readonly identity: FileIdentity
      /** The type the name or declaration claims, checked against the bytes. */
      readonly claimed?: { readonly modality: Modality; readonly mimeType?: string; readonly from: "name" | "artifact" }
      readonly artifact?: { readonly id: string; readonly bytes: number; readonly sha256: string }
    }

export type Modality = "text" | "image" | "pdf"

/** An immutable private snapshot of what was approved and read. */
export interface Snapshot {
  readonly origin: "text" | "path" | "artifact"
  readonly modality: Modality
  readonly mimeType: string
  readonly bytes: number
  readonly sha256: string
  readonly codePoints?: number
  readonly artifactId?: string
  readonly label?: string
  /** A fresh copy of the bytes. The snapshot's own copy is never handed out. */
  content(): Uint8Array
  /** The text, for a text snapshot. */
  text(): string
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const slash = (value: string) => value.split(sep).join("/")
const contains = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Step 1: identify the source. Reads metadata only; refuses unsafe paths and foreign or expired artifacts. */
export async function locate(source: Source, project: Project, files: FileAccess, now: Date): Promise<Located> {
  switch (source.kind) {
    case "text":
      return { kind: "text", text: source.text, ...(source.label === undefined ? {} : { label: source.label }) }
    case "bundle":
      throw new InferenceError("CAPABILITY_UNSUPPORTED", "Bundles of prepared evidence are not accepted in this version.", "Pass one text, path or artifact source.")
    case "path": {
      const { modality, mimeType, fromName } = modalityOf(source)
      return locateFile(source.path, project, files, modality === "unknown" ? undefined : { modality, ...(mimeType ? { mimeType } : {}), from: fromName ? "name" : "artifact" })
    }
    case "artifact": {
      const artifact = source.artifact
      // An artifact is identity and provenance, not a permission: scope and expiry are checked before anything else,
      // and the file is then approved and read like any path.
      if (artifact.projectId !== project.id)
        throw new InferenceError("UNSAFE_PATH", "The artifact belongs to another project.", "Use an artifact produced in this project, or import the file here first.")
      if (artifact.expiresAt !== undefined && Date.parse(artifact.expiresAt) <= now.getTime())
        throw new InferenceError("SOURCE_CHANGED", "The artifact has expired.", "Ask its producer for a fresh artifact, or select the file by path.")
      if (!isAbsolute(artifact.locator.path)) throw new InferenceError("UNSAFE_PATH", "The artifact's locator is not an absolute path.")
      const { modality, mimeType } = modalityOf(source)
      const located = await locateFile(artifact.locator.path, project, files, modality === "unknown" ? undefined : { modality, ...(mimeType ? { mimeType } : {}), from: "artifact" })
      if (located.kind !== "file") throw new InferenceError("UNSAFE_PATH")
      if (located.identity.size !== BigInt(artifact.bytes)) throw new InferenceError("SOURCE_CHANGED", "The artifact's file no longer has its declared size.")
      return { ...located, artifact: { id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256 } }
    }
  }
}

async function locateFile(path: string, project: Project, files: FileAccess, claimed: Extract<Located, { kind: "file" }>["claimed"]): Promise<Located> {
  // A '..' segment is refused outright rather than normalised away: the caller names the file it means.
  if (path.split(/[\\/]/).includes("..")) throw new InferenceError("UNSAFE_PATH", "The source path contains '..'.")
  const absolute = resolve(project.directory, path)
  const roots = [project.directory, project.worktree]
  const internal = roots.some((root) => contains(root, absolute))
  const inspection = await files.inspect(absolute, roots)
  if (inspection.kind === "missing") throw new InferenceError("UNSAFE_PATH", "The source file does not exist.")
  if (inspection.kind === "symlink") throw new InferenceError("UNSAFE_PATH", "The source path is a symbolic link.")
  if (inspection.kind === "other" || !inspection.identity) throw new InferenceError("UNSAFE_PATH", "The source path is not a regular file.")
  if (inspection.linkedWithinRoot) throw new InferenceError("UNSAFE_PATH", "The source path passes through a symbolic link inside the project.")
  return {
    kind: "file",
    absolute,
    internal,
    // The host's own read tool names an internal file relative to the location, and an external one absolutely.
    resource: internal ? slash(relative(project.directory, absolute)) || "." : slash(absolute),
    identity: inspection.identity,
    ...(claimed ? { claimed } : {}),
  }
}

/** Step 2: what the host must approve before any byte is read, in the host read tool's own actions. */
export function permissionRequests(located: Located): PermissionRequest[] {
  if (located.kind === "text") return []
  const requests: PermissionRequest[] = []
  if (!located.internal) {
    const directory = slash(resolve(located.absolute, ".."))
    requests.push({ action: "external_directory", resources: [`${directory}/*`], save: [`${directory}/*`] })
  }
  requests.push({ action: "read", resources: [located.resource], save: ["*"] })
  return requests
}

/** The type of some bytes, from the bytes. A name or a declaration never decides it. */
export function sniff(bytes: Uint8Array): { mimeType: string; modality?: Modality } {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  const ascii = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (ascii(0, "%PDF-")) return { mimeType: "application/pdf", modality: "pdf" }
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mimeType: "image/png", modality: "image" }
  if (starts(0xff, 0xd8, 0xff)) return { mimeType: "image/jpeg", modality: "image" }
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { mimeType: "image/webp", modality: "image" }
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return { mimeType: "image/gif", modality: "image" }
  if (isText(bytes)) return { mimeType: "text/plain", modality: "text" }
  return { mimeType: "application/octet-stream" }
}

/** Valid UTF-8 with no NUL and no control characters other than tab, line feed, form feed and carriage return. */
function isText(bytes: Uint8Array) {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(decoded)
}

/** The byte limit for one modality on a route: its documented limit, never above the hard ceiling. */
export function byteLimit(route: RouteCapability | undefined, modality: Modality | undefined) {
  const documented = modality === "image" ? (route?.inputs.images?.maxBytesEach ?? route?.maxRequestBytes) : route?.maxRequestBytes
  return Math.min(SOURCE_MAX_BYTES, documented ?? SOURCE_MAX_BYTES)
}

function freeze(fields: Omit<Snapshot, "content" | "text">, bytes: Uint8Array): Snapshot {
  const own = Uint8Array.from(bytes)
  return Object.freeze({
    ...fields,
    content: () => Uint8Array.from(own),
    text: () => {
      if (fields.modality !== "text") throw new InferenceError("CAPABILITY_UNSUPPORTED", "The source is not text.")
      return new TextDecoder("utf-8").decode(own)
    },
  })
}

/**
 * Step 3, after approval: read and freeze the source. `route` gives the documented byte limits; the snapshot's type
 * comes from its bytes and must agree with what its name or declaration claimed.
 */
export async function snapshot(located: Located, files: FileAccess, route: RouteCapability | undefined, signal: AbortSignal): Promise<Snapshot> {
  fence(signal)
  if (located.kind === "text") {
    const bytes = new TextEncoder().encode(located.text)
    if (bytes.byteLength > byteLimit(route, "text")) throw new InferenceError("SOURCE_LIMIT", "The supplied text is larger than the route accepts.")
    return freeze(
      {
        origin: "text",
        modality: "text",
        mimeType: "text/plain",
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        codePoints: [...located.text].length,
        ...(located.label === undefined ? {} : { label: located.label }),
      },
      bytes,
    )
  }
  // The largest any accepted modality allows; the sniffed modality's own limit is checked after reading.
  const ceiling = Math.max(byteLimit(route, "text"), byteLimit(route, "image"), byteLimit(route, "pdf"))
  if (located.identity.size > BigInt(ceiling)) throw new InferenceError("SOURCE_LIMIT", `The source file is larger than the ${ceiling} bytes the route accepts.`)
  let bytes: Uint8Array
  try {
    bytes = await files.read(located.absolute, located.identity, ceiling)
  } catch (error) {
    if (!(error instanceof FileProblem)) throw new InferenceError("UNSAFE_PATH", "The source file could not be read.")
    if (error.kind === "too_large") throw new InferenceError("SOURCE_LIMIT", `The source file is larger than the ${ceiling} bytes the route accepts.`)
    if (error.kind === "changed" || error.kind === "missing") throw new InferenceError("SOURCE_CHANGED", "The source file was replaced or changed after it was approved.")
    throw new InferenceError("UNSAFE_PATH", error.kind === "symlink" ? "The source path became a symbolic link after it was approved." : "The source file could not be read as a regular file.")
  }
  fence(signal)
  const type = sniff(bytes)
  if (!type.modality) throw new InferenceError("SOURCE_TYPE", `The source's bytes are ${type.mimeType}, which no route accepts.`)
  if (located.claimed && !agrees(located.claimed, type)) {
    const said = located.claimed.mimeType ?? located.claimed.modality
    throw new InferenceError("SOURCE_TYPE", `The source's ${located.claimed.from === "name" ? "name says" : "artifact declares"} ${said}, but its bytes are ${type.mimeType}.`)
  }
  if (bytes.byteLength > byteLimit(route, type.modality)) throw new InferenceError("SOURCE_LIMIT", `The ${type.modality} source is larger than the route accepts.`)
  const hash = sha256(bytes)
  if (located.artifact && (located.artifact.bytes !== bytes.byteLength || located.artifact.sha256 !== hash))
    throw new InferenceError("SOURCE_CHANGED", "The artifact's file no longer matches its declared size and hash.")
  const text = type.modality === "text" ? new TextDecoder("utf-8").decode(bytes) : undefined
  return freeze(
    {
      origin: located.artifact ? "artifact" : "path",
      modality: type.modality,
      mimeType: type.mimeType,
      bytes: bytes.byteLength,
      sha256: hash,
      ...(text === undefined ? {} : { codePoints: [...text].length }),
      ...(located.artifact ? { artifactId: located.artifact.id } : {}),
    },
    bytes,
  )
}

const agrees = (claimed: NonNullable<Extract<Located, { kind: "file" }>["claimed"]>, actual: { mimeType: string; modality?: Modality }) =>
  claimed.modality === actual.modality && (claimed.mimeType === undefined || claimed.modality === "text" || claimed.mimeType === actual.mimeType)
