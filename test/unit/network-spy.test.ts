import { expect, test } from "bun:test"
import dns from "node:dns"
import http from "node:http"
import http2 from "node:http2"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { spyNetwork } from "../support/network-spy.js"

test("the network spy records and refuses every path: fetch, http(s), http2, net, tls, dns and WebSocket", async () => {
  const spy = spyNetwork()
  try {
    const attempts: (() => unknown)[] = [
      () => fetch("http://127.0.0.1:9"),
      () => http.request("http://127.0.0.1:9"),
      () => https.get("https://127.0.0.1:9"),
      () => http2.connect("https://127.0.0.1:9"),
      () => net.connect(9, "127.0.0.1"),
      () => tls.connect(9, "127.0.0.1"),
      () => dns.lookup("example.invalid", () => undefined),
      () => dns.resolve("example.invalid", () => undefined),
      () => dns.promises.lookup("example.invalid"),
      () => new WebSocket("ws://127.0.0.1:9"),
    ]
    for (const attempt of attempts) expect(attempt).toThrow(/network call blocked in a local test/)
    expect(spy.calls.map((call) => call.split(" ")[0])).toEqual(["fetch", "http.request", "https.get", "http2.connect", "net.connect", "tls.connect", "dns.lookup", "dns.resolve", "dns.promises.lookup", "WebSocket"])
  } finally {
    spy.restore()
  }
  expect(typeof globalThis.fetch).toBe("function")
})
