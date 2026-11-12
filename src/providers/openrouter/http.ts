import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { INTEGRATION_ID } from "../../domain/ids.js"

// The transport boundary: the ONLY module allowed to call `fetch` or resolve the OpenRouter key (`npm run lint`
// enforces both). Everything that leaves the machine goes through `post`:
//
// - one trusted origin, fixed in code: https://openrouter.ai. A loopback origin is accepted for tests only. A path is a
//   fixed API path, never a URL from a response or an input;
// - the key is resolved here, at dispatch, from the plugin's own integration, put into one header and nowhere else. It
//   is never logged, returned, stored or put into an error;
// - redirects are never followed, so the key never reaches another origin, and a 3xx answer is a failure;
// - a deadline, a request-size cap, a streamed response-byte cap and the caller's cancellation all apply;
// - every failure says whether the request can have been sent (`sent`), which decides what the journal records.

export const OPENROUTER_ORIGIN = "https://openrouter.ai"
/** The API paths this transport may call. A path is matched exactly. */
export const API_PATHS = ["/api/alpha/extractions", "/api/alpha/decisions"] as const
// Captured at module load: the request URL is the trusted origin string plus one of these exact path strings, compared
// with ===, so no later change to a built-in (URL, Array.prototype.includes, Set.prototype.has) can widen either.
const PATH_EXTRACTIONS = API_PATHS[0]
const PATH_DECISIONS = API_PATHS[1]
const reviewedPath = (path: unknown) => path === PATH_EXTRACTIONS || path === PATH_DECISIONS

type Integration = Pick<Plugin.Context["integration"], "connection">
type Connection = NonNullable<Awaited<ReturnType<Integration["connection"]["active"]>>>

/** The account a request is billed to, by a non-secret label. Never the key. */
export interface Account {
  /** `openrouter:<16 hex>`: a hash of the host's connection id, stable while the same key stays connected. */
  readonly scope: string
  readonly connection: Connection
}

export interface TransportRequest {
  readonly path: string
  readonly body: Uint8Array
  readonly account: Account
  readonly deadlineMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly signal: AbortSignal
}

export interface TransportResponse {
  readonly status: number
  readonly contentType?: string
  readonly requestId?: string
  readonly body: Uint8Array
  readonly elapsedMs: number
}

export type TransportFailure =
  | "auth_missing" // no usable key: nothing was sent
  | "path_refused" // not a reviewed API path on the trusted origin: nothing was sent
  | "request_too_large" // refused before sending
  | "not_sent" // the connection could not be opened: nothing was sent
  | "redirect" // the server answered with a redirect, which is never followed
  | "response_too_large" // the answer passed the byte cap and was cut off
  | "timeout" // the deadline passed after the request may have been sent
  | "cancelled" // the caller cancelled after the request may have been sent
  | "ambiguous" // the connection failed after the request may have been sent

/** A transport failure. Its message is the kind alone: no URL, header, key or body. */
export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailure,
    /** False only when the request certainly did not leave this process. */
    readonly sent: boolean,
  ) {
    super(kind)
    this.name = "TransportError"
  }
}

export interface Transport {
  /** The connected account, from the host's active connection. Reads no key. */
  account(): Promise<Account | "needs_auth" | undefined>
  post(request: TransportRequest): Promise<TransportResponse>
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

/** The trusted origin: OpenRouter itself, or a loopback server in tests. Anything else is refused at construction. */
function trustedOrigin(origin: string) {
  const url = new URL(origin)
  if (url.origin !== origin) throw new Error("the transport origin must be a bare origin")
  if (origin === OPENROUTER_ORIGIN) return url
  if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname)) return url
  throw new Error("the transport origin must be OpenRouter or a loopback test server")
}

const scopeOf = (connection: Connection) =>
  `openrouter:${createHash("sha256").update(connection.type === "credential" ? `credential:${connection.id}` : `env:${connection.name}`).digest("hex").slice(0, 16)}`

/** Error codes that mean the connection was never opened, so no request byte left. */
const NOT_SENT = /^(?:ECONNREFUSED|ConnectionRefused|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|FailedToOpenSocket|CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_)/
const codeOf = (error: unknown): string => {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | undefined
  return String(value?.code ?? value?.cause?.code ?? "")
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/

export function createTransport(integration: Integration, origin: string = OPENROUTER_ORIGIN): Transport {
  // The origin is validated once, here, and kept as a string; requests never parse a URL again.
  trustedOrigin(origin)
  const base = origin

  const account = async (): Promise<Account | "needs_auth" | undefined> => {
    const connection = await integration.connection.active(INTEGRATION_ID)
    if (!connection) return undefined
    if (connection.status) return "needs_auth"
    return { scope: scopeOf(connection), connection }
  }

  /** The key, resolved now, only if the active connection is still the one the reservation was made for. */
  const key = async (expected: Account) => {
    const connection = await integration.connection.active(INTEGRATION_ID).catch(() => undefined)
    if (!connection || connection.status || scopeOf(connection) !== expected.scope) throw new TransportError("auth_missing", false)
    const credential = await integration.connection.resolve(connection).catch(() => undefined)
    if (!credential || credential.type !== "key" || typeof credential.key !== "string" || credential.key.length === 0 || /[\r\n]/.test(credential.key))
      throw new TransportError("auth_missing", false)
    return credential.key
  }

  const post = async (request: TransportRequest): Promise<TransportResponse> => {
    if (!reviewedPath(request.path)) throw new TransportError("path_refused", false)
    const url = base + request.path
    if (request.body.byteLength > request.maxRequestBytes) throw new TransportError("request_too_large", false)
    if (request.signal.aborted) throw new TransportError("cancelled", false)

    // One deadline and the caller's cancellation cover the key lookup as well as the request.
    const deadline = AbortSignal.timeout(request.deadlineMs)
    const signal = AbortSignal.any([request.signal, deadline])
    const secret = await new Promise<string>((resolve, reject) => {
      const stop = () => reject(new TransportError(request.signal.aborted ? "cancelled" : "timeout", false))
      if (signal.aborted) return stop()
      signal.addEventListener("abort", stop, { once: true })
      key(request.account).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
    })
    const failure = (error: unknown, sent: boolean): TransportError => {
      if (error instanceof TransportError) return error
      if (request.signal.aborted) return new TransportError("cancelled", sent)
      if (deadline.aborted) return new TransportError("timeout", sent)
      if (!sent || NOT_SENT.test(codeOf(error))) return new TransportError("not_sent", false)
      return new TransportError("ambiguous", true)
    }
    const started = Date.now()
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/json" },
        body: Uint8Array.from(request.body),
        // Never follow: a followed redirect could carry the key to another origin, and a POST must not be replayed.
        redirect: "manual",
        signal,
      })
    } catch (error) {
      throw failure(error, true)
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      throw new TransportError("redirect", true)
    }
    const declared = Number(response.headers.get("content-length") ?? "NaN")
    if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new TransportError("response_too_large", true)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > request.maxResponseBytes) {
            await reader.cancel().catch(() => undefined)
            throw new TransportError("response_too_large", true)
          }
          chunks.push(value)
        }
      }
    } catch (error) {
      throw failure(error, true)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const requestId = response.headers.get("x-request-id") ?? undefined
    const contentType = response.headers.get("content-type") ?? undefined
    return {
      status: response.status,
      ...(contentType ? { contentType: contentType.slice(0, 128) } : {}),
      ...(requestId && REQUEST_ID.test(requestId) ? { requestId } : {}),
      body,
      elapsedMs: Date.now() - started,
    }
  }

  return { account, post }
}
