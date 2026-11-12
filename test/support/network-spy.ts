// Every way the plugin could reach a network, spied. Any call is recorded and refused, so a test can assert that a
// local surface, or a refused operation, sent nothing.
import dgram from "node:dgram"
import dns from "node:dns"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"

export function spyNetwork() {
  const calls: string[] = []
  const restore: (() => void)[] = []
  const patch = <T extends object>(target: T, key: string, label: string) => {
    const original = (target as Record<string, unknown>)[key]
    ;(target as Record<string, unknown>)[key] = (...args: unknown[]) => {
      calls.push(`${label} ${String(args[0]).slice(0, 80)}`)
      throw new Error(`network call blocked in a local test: ${label}`)
    }
    restore.push(() => void ((target as Record<string, unknown>)[key] = original))
  }
  patch(globalThis, "fetch", "fetch")
  patch(http, "request", "http.request")
  patch(http, "get", "http.get")
  patch(https, "request", "https.request")
  patch(https, "get", "https.get")
  patch(http2, "connect", "http2.connect")
  patch(net, "connect", "net.connect")
  patch(net, "createConnection", "net.createConnection")
  patch(tls, "connect", "tls.connect")
  // A socket created directly, then connected; Bun's own TCP client; UDP.
  patch(net.Socket.prototype, "connect", "net.Socket.connect")
  patch(Bun, "connect", "Bun.connect")
  patch(dgram, "createSocket", "dgram.createSocket")
  for (const name of ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt", "resolveSrv"]) patch(dns, name, `dns.${name}`)
  for (const name of ["lookup", "resolve", "resolve4", "resolve6"]) patch(dns.promises, name, `dns.promises.${name}`)
  // A constructor, so it is replaced by a class that records and refuses.
  const OriginalWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor(url: unknown) {
      calls.push(`WebSocket ${String(url).slice(0, 80)}`)
      throw new Error("network call blocked in a local test: WebSocket")
    }
  } as unknown as typeof WebSocket
  restore.push(() => void (globalThis.WebSocket = OriginalWebSocket))
  return { calls, restore: () => restore.splice(0).reverse().forEach((undo) => undo()) }
}
