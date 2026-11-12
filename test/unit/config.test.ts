import { describe, expect, test } from "bun:test"
import { DEFAULT_PROFILES, loadConfig } from "../../src/domain/config.js"

describe("the plugin options", () => {
  test("default to the confirmed defaults, with every module except reading on and no secrets", () => {
    const config = loadConfig(undefined)
    expect(config).toEqual({
      access: "all",
      modules: { extractions: true, decisions: true, understanding: false },
      profiles: DEFAULT_PROFILES,
      routing: { mode: "explicit", fallbacks: [] },
      limits: { concurrency: 2, maxFields: 32, deadlineMs: 60_000 },
      spend: { requestUsd: "0.05", sessionUsd: "1.00", rolling24hUsd: "5.00", requirePricedRoute: true, requireUpperBound: false },
      data: { requireZdr: false },
      cache: { enabled: false },
      allowUntestedHost: false,
      questionSets: {},
      acceptanceProfiles: {},
    })
    expect(JSON.stringify(config)).not.toMatch(/key|token|secret/i)
  })

  test("accept the documented shape, and profiles replace the defaults", () => {
    const config = loadConfig({
      access: "ask-changes",
      modules: { decisions: false },
      profiles: { "invoice-text": { model: "cloudflare/clairic" } },
      routing: { mode: "explicit", fallbacks: [] },
      limits: { maxFields: 8 },
      spend: { requestUsd: "0.01", requireUpperBound: true },
      data: { requireZdr: true },
      cache: { enabled: false },
    })
    expect(config.access).toBe("ask-changes")
    expect(config.modules).toEqual({ extractions: true, decisions: false, understanding: false })
    expect(config.profiles).toEqual({ "invoice-text": { model: "cloudflare/clairic" } })
    expect(config.limits).toEqual({ concurrency: 2, maxFields: 8, deadlineMs: 60_000 })
    expect(config.spend).toMatchObject({ requestUsd: "0.01", sessionUsd: "1.00", requireUpperBound: true })
    expect(config.data.requireZdr).toBe(true)
  })

  test("are strict: an unknown key is named, at any depth", () => {
    expect(() => loadConfig({ acess: "all" })).toThrow(/OPTIONS_INVALID: .*options\.acess is not an Inference option/)
    expect(() => loadConfig({ limits: { maxFeilds: 3 } })).toThrow(/options\.limits\.maxFeilds is not an Inference option/)
    expect(() => loadConfig({ profiles: { "x": { model: "cloudflare/clairic", temperature: 0 } } })).toThrow(/options\.profiles\.x\.temperature/)
  })

  test("refuse invalid values with the option named and the next step", () => {
    for (const options of [
      { access: "everything" },
      { limits: { maxFields: 0 } },
      { limits: { maxFields: 65 } },
      { spend: { requestUsd: 0.05 } },
      { spend: { requestUsd: "-1" } },
      { profiles: { Bad_Name: { model: "cloudflare/clairic" } } },
      { profiles: { good: { model: "no-slash" } } },
      { routing: { mode: "auto" } },
    ])
      expect(() => loadConfig(options)).toThrow(/OPTIONS_INVALID: .* Next step: Fix the named option/)
  })

  test("refuse what is not implemented: automatic fallback and the result cache", () => {
    expect(() => loadConfig({ routing: { fallbacks: ["scaledown/extract"] } })).toThrow(/automatic fallback is not supported/)
    expect(() => loadConfig({ cache: { enabled: true } })).toThrow(/the result cache is not implemented yet/)
  })

  test("never take a secret: a key-like option is refused by path, and its value is never echoed", () => {
    const value = "sk-or-v1-THIS-MUST-NOT-APPEAR"
    for (const options of [{ apiKey: value }, { openrouter: { api_key: value } }, { profiles: { p: { model: "a/b", token: value } } }, { authorization: value }]) {
      let message = ""
      try {
        loadConfig(options)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toMatch(/^OPTIONS_INVALID: .*look like secrets.*Next step: .*\/connect/)
      expect(message).not.toContain(value)
    }
  })
})
