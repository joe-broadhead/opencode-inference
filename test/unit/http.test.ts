// The transport boundary against loopback fake servers: the key goes only to the trusted origin, in one header;
// redirects are never followed, so another origin never sees it; the deadline, the response cap and cancellation hold;
// and every failure says whether anything can have been sent. No test leaves loopback.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { createTransport, TransportError, type Account } from "../../src/providers/openrouter/http.js"

const KEY = "sk-or-v1-TEST-KEY-NEVER-LEAKS-0000"
const CONNECTION = { type: "credential", id: "cred_1", label: "test", method: "key" } as const

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: IncomingMessage["headers"]
  readonly body: string
}

const servers: Server[] = []
async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body })
      handler(request, response, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server }
}
const logged: unknown[] = []
const consoleMethods = ["log", "info", "warn", "error", "debug"] as const
const originals = consoleMethods.map((name) => console[name])
beforeAll(() => consoleMethods.forEach((name) => (console[name] = (...args: unknown[]) => void logged.push(args))))
afterAll(() => {
  servers.forEach((server) => server.close())
  consoleMethods.forEach((name, index) => (console[name] = originals[index]!))
  // The transport logs nothing, so it cannot log the key.
  expect(logged).toEqual([])
})

/** `key: null` means the host resolves no credential. */
const integration = (key: string | null = KEY, active: unknown = CONNECTION) => {
  const resolved: unknown[] = []
  return {
    resolved,
    integration: {
      connection: {
        active: async () => active as never,
        resolve: async (connection: unknown) => (resolved.push(connection), key === null ? undefined : ({ type: "key", key } as never)),
        status: async () => undefined,
      },
    } as never,
  }
}

const request = (account: Account, overrides: Partial<Parameters<ReturnType<typeof createTransport>["post"]>[0]> = {}) => ({
  path: "/api/alpha/extractions",
  body: new TextEncoder().encode('{"hello":"world"}'),
  account,
  deadlineMs: 2000,
  maxRequestBytes: 1024,
  maxResponseBytes: 1024,
  signal: new AbortController().signal,
  ...overrides,
})

const failureOf = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (error) {
    if (error instanceof TransportError) return error
    throw error
  }
  throw new Error("expected a transport failure")
}

describe("the transport boundary", () => {
  test("posts to the trusted origin with the key in the authorization header only, and returns a bounded answer", async () => {
    const api = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "req_123" })
      response.end('{"ok":true}')
    })
    const { integration: host, resolved } = integration()
    const transport = createTransport(host, api.origin)
    const account = await transport.account()
    // (Read the field: Bun's toMatchObject with an asymmetric matcher writes the matcher into the object.)
    expect((account as Account).scope).toMatch(/^openrouter:[0-9a-f]{16}$/)
    expect(JSON.stringify(account)).not.toContain(KEY)
    // account() reads no key.
    expect(resolved).toEqual([])
    const answer = await transport.post(request(account as Account))
    expect(answer).toMatchObject({ status: 200, contentType: "application/json", requestId: "req_123" })
    expect(new TextDecoder().decode(answer.body)).toBe('{"ok":true}')
    expect(api.seen).toHaveLength(1)
    expect(api.seen[0]).toMatchObject({ method: "POST", url: "/api/alpha/extractions", body: '{"hello":"world"}' })
    expect(api.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    const others = Object.entries(api.seen[0]!.headers).filter(([name]) => name !== "authorization")
    expect(JSON.stringify(others)).not.toContain(KEY)
    expect(JSON.stringify(answer)).not.toContain(KEY)
  })

  test("a redirect to another origin is never followed: the other origin receives nothing, and certainly not the key", async () => {
    const elsewhere = await serve((_request, response) => response.end("{}"))
    for (const status of [301, 302, 307, 308]) {
      const api = await serve((_request, response) => {
        response.writeHead(status, { location: `${elsewhere.origin}/steal` })
        response.end()
      })
      const transport = createTransport(integration().integration, api.origin)
      const error = await failureOf(transport.post(request((await transport.account()) as Account)))
      expect([error.kind, error.sent]).toEqual(["redirect", true])
      expect(error.message).not.toContain(KEY)
      expect(error.message).not.toContain(elsewhere.origin)
    }
    expect(elsewhere.seen).toEqual([])
  })

  test("the response byte cap holds, declared or streamed", async () => {
    const declared = await serve((_request, response) => {
      response.writeHead(200, { "content-length": "4096" })
      response.end("x".repeat(4096))
    })
    const streamed = await serve((_request, response) => {
      response.writeHead(200)
      let sent = 0
      const timer = setInterval(() => {
        if (sent++ > 64 || response.destroyed) {
          clearInterval(timer)
          response.end()
          return
        }
        response.write("y".repeat(512))
      }, 1)
    })
    for (const api of [declared, streamed]) {
      const transport = createTransport(integration().integration, api.origin)
      const error = await failureOf(transport.post(request((await transport.account()) as Account)))
      expect([error.kind, error.sent]).toEqual(["response_too_large", true])
    }
  })

  test("the deadline holds: a server that never answers times out as sent, within the deadline", async () => {
    const api = await serve(() => undefined)
    const transport = createTransport(integration().integration, api.origin)
    const started = Date.now()
    const error = await failureOf(transport.post(request((await transport.account()) as Account, { deadlineMs: 150 })))
    expect([error.kind, error.sent]).toEqual(["timeout", true])
    expect(Date.now() - started).toBeLessThan(1500)
  })

  test("cancellation stops the request: before sending nothing leaves; after, it may have been sent", async () => {
    const api = await serve(() => undefined)
    const transport = createTransport(integration().integration, api.origin)
    const account = (await transport.account()) as Account
    const early = new AbortController()
    early.abort()
    expect(await failureOf(transport.post(request(account, { signal: early.signal })))).toMatchObject({ kind: "cancelled", sent: false })
    expect(api.seen).toEqual([])
    const late = new AbortController()
    setTimeout(() => late.abort(), 50)
    expect(await failureOf(transport.post(request(account, { signal: late.signal })))).toMatchObject({ kind: "cancelled", sent: true })
  })

  test("a connection that cannot be opened is not_sent", async () => {
    const api = await serve(() => undefined)
    const origin = api.origin
    await new Promise((resolve) => api.server.close(resolve))
    servers.splice(servers.indexOf(api.server), 1)
    const transport = createTransport(integration().integration, origin)
    expect(await failureOf(transport.post(request((await transport.account()) as Account)))).toMatchObject({ kind: "not_sent", sent: false })
  })

  test("no key, a changed connection or a request over the cap: nothing leaves this process", async () => {
    const api = await serve((_request, response) => response.end("{}"))
    const missing = createTransport(integration(null).integration, api.origin)
    expect(await failureOf(missing.post(request((await missing.account()) as Account)))).toMatchObject({ kind: "auth_missing", sent: false })
    const original = createTransport(integration().integration, api.origin)
    const account = (await original.account()) as Account
    const switched = createTransport(integration(KEY, { ...CONNECTION, id: "cred_2" }).integration, api.origin)
    expect(await failureOf(switched.post(request(account)))).toMatchObject({ kind: "auth_missing", sent: false })
    expect(await failureOf(original.post(request(account, { maxRequestBytes: 4 })))).toMatchObject({ kind: "request_too_large", sent: false })
    expect(api.seen).toEqual([])
    expect(await createTransport(integration(KEY, null).integration, api.origin).account()).toBeUndefined()
    expect(await createTransport(integration(KEY, { ...CONNECTION, status: { type: "needs_auth" } }).integration, api.origin).account()).toBe("needs_auth")
  })

  test("the key lookup is under the same deadline and cancellation as the request; nothing is sent", async () => {
    const api = await serve((_request, response) => response.end("{}"))
    const hanging = {
      connection: { active: async () => CONNECTION as never, resolve: () => new Promise<never>(() => undefined), status: async () => undefined },
    } as never
    const transport = createTransport(hanging, api.origin)
    const account = (await transport.account()) as Account
    const started = Date.now()
    expect(await failureOf(transport.post(request(account, { deadlineMs: 100 })))).toMatchObject({ kind: "timeout", sent: false })
    expect(Date.now() - started).toBeLessThan(1500)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)
    expect(await failureOf(transport.post(request(account, { signal: controller.signal })))).toMatchObject({ kind: "cancelled", sent: false })
    expect(api.seen).toEqual([])
  })

  test("only the trusted origin and the reviewed paths: anything else is refused before a request exists", async () => {
    for (const origin of ["https://evil.example", "http://openrouter.ai", "https://openrouter.ai.evil.example", "https://openrouter.ai/api", "file:///etc"])
      expect(() => createTransport(integration().integration, origin)).toThrow()
    expect(() => createTransport(integration().integration)).not.toThrow()
    const api = await serve((_request, response) => response.end("{}"))
    const transport = createTransport(integration().integration, api.origin)
    const account = (await transport.account()) as Account
    for (const path of ["/api/v1/chat/completions", "//evil.example/api/alpha/extractions", "https://evil.example/api/alpha/extractions", "/api/alpha/extractions?x=1"])
      expect(await failureOf(transport.post(request(account, { path })))).toMatchObject({ kind: "path_refused", sent: false })
    expect(api.seen).toEqual([])
  })
})
