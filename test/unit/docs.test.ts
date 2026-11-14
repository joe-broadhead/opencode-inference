// The docs and skills cannot drift from what is registered: every tool name, Code Mode path, tools RPC method and Jobs
// manifest entry they mention is real; every tagged example is valid input by the registry's own schema; the plan
// example's documented outcome is what plan returns; every error code they mention exists.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../../src/domain/config.js"
import { EXCLUSIONS, PlanInput } from "../../src/domain/contracts.js"
import { FAILURES } from "../../src/domain/errors.js"
import { implemented, PLANNED, TOOLS } from "../../src/domain/registry.js"
import { plan } from "../../src/domain/routing.js"
import { NEXT_STEPS } from "../../src/host/tools-rpc.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const FILES = ["README.md", "SECURITY.md", "CONTRIBUTING.md", ...readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`), ...readdirSync(join(ROOT, "skills")).map((id) => `skills/${id}/SKILL.md`)]
const text = (file: string) => readFileSync(join(ROOT, file), "utf8")
const REGISTERED = new Set<string>(TOOLS.map((tool) => tool.name))
const RESERVED = new Set<string>(PLANNED.map((operation) => operation.name))

describe("the docs and skills name only what is registered", () => {
  test("tool names, Code Mode paths, tools RPC methods and Jobs manifest entries", () => {
    const problems: string[] = []
    for (const file of FILES) {
      const content = text(file)
      const check = (pattern: RegExp, allowReserved: boolean) => {
        for (const match of content.matchAll(pattern)) {
          const name = match[1]!
          if (REGISTERED.has(name) || (allowReserved && RESERVED.has(name))) continue
          problems.push(`${file}: ${match[0]}`)
        }
      }
      // The host tool id; a reserved one may be named as reserved.
      check(/\binference_([a-z]+)\b/g, true)
      check(/\btools\.inference\.(?!core\.)([a-z_]+)\b/g, true)
      check(/\binference\.core\.tools\/([a-z_]+)\b/g, false)
      check(/\btools\.inference\.core\.([a-z_]+)\b/g, false)
      check(/(?<![/.\w])inference\.core\.(?!tools\b|tui\b)([a-z_]+)\b/g, false)
    }
    expect(problems).toEqual([])
    // A reserved name is never presented as a tool that runs.
    for (const name of RESERVED) expect(implemented(name)).toBe(false)
  })

  test("every tagged example is valid input for its tool, by the registry's own schema", () => {
    const seen: string[] = []
    for (const file of FILES)
      for (const match of text(file).matchAll(/<!-- example: (\w+) -->\n```json\n([\s\S]*?)\n```/g)) {
        const tool = TOOLS.find((item) => item.name === match[1])
        const valid = tool !== undefined && tool.input.safeParse(JSON.parse(match[2]!)).success
        expect({ file, tool: match[1], valid }).toEqual({ file, tool: match[1], valid: true })
        seen.push(`${file}:${match[1]}`)
      }
    expect(seen.sort()).toEqual(["docs/scripting.md:decide", "docs/scripting.md:extract", "docs/scripting.md:plan", "skills/inference-decide/SKILL.md:decide", "skills/inference-extract/SKILL.md:extract"])
  })

  test("the plan example's documented outcome is what plan returns", () => {
    const doc = text("docs/scripting.md")
    const input = JSON.parse(/<!-- example: plan -->\n```json\n([\s\S]*?)\n```/.exec(doc)![1]!)
    const outcome = /<!-- outcome: plan -->\n([\s\S]*?)\n\n/.exec(doc)![1]!
    const result = plan(PlanInput.parse(input), { config: loadConfig({}), fixture: OPENROUTER_CAPABILITIES, implemented, now: new Date() })
    const exclusions = result.route.selected!.exclusions
    for (const code of EXCLUSIONS) expect({ code, documented: outcome.includes(`\`${code}\``) }).toEqual({ code, documented: exclusions.includes(code) })
  })

  test("every error code the docs and skills mention exists", () => {
    const known = new Set([...Object.keys(FAILURES), ...Object.keys(NEXT_STEPS), ...EXCLUSIONS, "REVIEW_REQUIRED", "OUTPUT_EXPIRED", "OUTPUT_UNAVAILABLE", "CANCEL_UNSUPPORTED"])
    const problems: string[] = []
    for (const file of FILES)
      for (const match of text(file).matchAll(/`([A-Z][A-Z_]{4,})`/g)) if (!known.has(match[1]!) && !REASONS.has(match[1]!) && !IDENTIFIERS.has(match[1]!)) problems.push(`${file}: ${match[1]}`)
    expect(problems).toEqual([])
  })
})

/** Names in backticks that are not codes: files, constants and environment variables. */
const IDENTIFIERS = new Set(["NOTICE", "WIRE_REVISION", "CONTRACT_JSON_SCHEMAS", "ADAPTERS", "OPENROUTER_CANARY_KEY", "TESTED_HOSTS", "HOST_SDK_DIR", "XDG_STATE_HOME", "TMPDIR", "OPENCODE_TEST_HOME", "OPENCODE_BIN_2_2_3"])

/** Review and acceptance reason codes, which the docs also name. */
const REASONS = new Set(["FIELD_ABSENT", "REQUIRED_FIELD_ABSENT", "CONFIDENCE_MISSING", "EVIDENCE_UNAVAILABLE", "EVIDENCE_MISMATCH", "VALIDATION_FAILED", "PROVIDER_TRUNCATED", "CALIBRATION_UNAVAILABLE", "CALIBRATION_MISMATCH", "REFUSED", "LOW_PROBABILITY", "AMBIGUOUS", "INCONSISTENT", "ACCEPTANCE_PROFILE_UNKNOWN", "RECOVERED_UNSENT", "RECOVERED_UNKNOWN"])

describe("operations.md keeps the no-retry and privacy lists complete", () => {
  test("a cancellation after sending is not retried, and every request field the adapters send is listed as sent", () => {
    const doc = text("docs/operations.md")
    expect(doc).toContain("`SUBMISSION_UNKNOWN` / `DEADLINE_EXCEEDED` / `CANCELLED` after sending")
    // Every top-level key an adapter puts in a request body is named in the privacy list.
    const privacy = /- \*\*What is sent:\*\*([\s\S]*?)\n- \*\*/.exec(doc)![1]!
    for (const file of ["src/providers/openrouter/extractions.ts", "src/providers/openrouter/decisions.ts"]) {
      const source = text(file)
      const keys = new Set([...source.matchAll(/body\["([a-z_]+)"\]/g)].map((match) => match[1]!))
      for (const key of ["reference_date"]) if (source.includes(`"${key}"`)) keys.add(key)
      for (const key of keys) expect({ file, key, listed: privacy.includes(key) || (key === "state" && privacy.includes("text")) || (key === "assets" && privacy.includes("image")) }).toEqual({ file, key, listed: true })
    }
  })
})

describe("the spend caps are opt-in, and every doc says so", () => {
  test("loadConfig sets no cap; configuration.md, operations.md, README and AGENTS.md say none is set by default, and none states the old caps as defaults", () => {
    const { spend } = loadConfig(undefined)
    expect({ requestUsd: spend.requestUsd, sessionUsd: spend.sessionUsd, rolling24hUsd: spend.rolling24hUsd }).toEqual({ requestUsd: null, sessionUsd: null, rolling24hUsd: null })
    // requirePricedRoute is a truthful-cost guard, not a limit, so it stays on.
    expect(spend.requirePricedRoute).toBe(true)
    for (const file of ["docs/configuration.md", "docs/operations.md", "README.md", "docs/jelly.md"]) expect({ file, stated: /no (?:spend )?cap is set by default/i.test(text(file).replace(/\s+/g, " ")) }).toEqual({ file, stated: true })
    expect(text("AGENTS.md").replace(/\s+/g, " ")).toContain("Every spend cap is opt-in")
    // The configuration table gives the same values.
    for (const key of ["requestUsd", "sessionUsd", "rolling24hUsd"]) expect(text("docs/configuration.md")).toContain(`| \`spend.${key}\` | \`null\` |`)
    // No user doc or guide still states the earlier default caps, and none speaks of the owner.
    for (const file of [...FILES, "AGENTS.md", "src/runtime/budget.ts", "src/domain/config.ts"]) expect({ file, old: /0\.05 per request|USD 0\.05, 1\.00|\.requestUsd`? 0\.05/.test(text(file).replace(/\s+/g, " ")) }).toEqual({ file, old: false })
    for (const file of ["README.md", "docs/configuration.md", "docs/operations.md"]) expect({ file, owner: /owner-confirmed|by the owner/i.test(text(file)) }).toEqual({ file, owner: false })
    // No doc, guide or source comment calls them proposed, under review or unconfirmed.
    const stale = /(?:proposed|proposals?|awaiting review|under review|not confirmed|has not confirmed)/i
    for (const file of [...FILES, "AGENTS.md", "src/runtime/budget.ts", "src/domain/config.ts", "src/host/status.ts"])
      for (const line of text(file).split("\n")) if (/spend|budget|cap\b/i.test(line) || /defaults/i.test(line)) expect({ file, line, stale: stale.test(line) }).toEqual({ file, line, stale: false })
  })
})


/** Orders two `x.y.z` versions. */
const compare = (left: string, right: string) => {
  const [a, b] = [left, right].map((value) => value.split(".").map(Number))
  for (let index = 0; index < 3; index++) if (a![index] !== b![index]) return a![index]! - b![index]!
  return 0
}

describe("the release", () => {
  test("installs from the release tag of package.json's version, with every install spec pinned to it, and states its known limits", () => {
    const { version } = JSON.parse(text("package.json")) as { version: string }
    for (const file of [...FILES, "AGENTS.md"]) {
      const specs = text(file).match(/(?:plugin remove )?github:joe-broadhead\/opencode-inference(?:#[^\s"'`)]*)?/g) ?? []
      // A spec whose tag is a placeholder, such as `#v<x>`, describes the form, not a release. The upgrade example
      // removes an earlier release's entry.
      for (const spec of specs.filter((item) => !item.includes("#v<"))) {
        if (spec.startsWith("plugin remove ")) expect({ file, earlier: compare(spec.slice(spec.indexOf("#v") + 2), version) < 0 }).toEqual({ file, earlier: true })
        else expect({ file, spec }).toEqual({ file, spec: `github:joe-broadhead/opencode-inference#v${version}` })
      }
    }
    const readme = text("README.md")
    expect(readme.match(/github:joe-broadhead\/opencode-inference#v/g)?.length).toBeGreaterThanOrEqual(3)
    expect(readme).not.toMatch(/not (?:yet )?released|not published/i)
    expect(readme).toContain("## Install\n")
    expect(readme).toContain("The install takes the GitHub release tag.")
    // The known limits name both enabled routes and what each covers, and the spend defaults the options actually have.
    const limits = readme.slice(readme.indexOf("## Known limits"), readme.indexOf("## License"))
    for (const route of OPENROUTER_CAPABILITIES.routes.filter((item) => item.enabled)) expect(limits).toContain(`\`${route.model}\``)
    for (const key of ["requestUsd", "sessionUsd", "rolling24hUsd"]) expect(limits).toContain(`\`spend.${key}\``)
    for (const phrase of ["text only", "noul, choice and score over text", "32 KB", "`review-first-v1`", "`ROUTE_NOT_VERIFIED`", "No cap is set by default"]) expect(limits).toContain(phrase)
  })
})

describe("the 0.0.0 release notes", () => {
  const notes = () => {
    const changelog = text("CHANGELOG.md")
    const start = changelog.indexOf("## [0.0.0]")
    const next = changelog.indexOf("\n## [", start + 1)
    return changelog.slice(start, next === -1 ? undefined : next)
  }

  test("describe what ships: the key is read for enabled routes, the send tools are registered, two routes are enabled", () => {
    const section = notes()
    expect(section).toStartWith("## [0.0.0] - ")
    // Statements an earlier stage made true and a later one made false.
    for (const stale of [/never reads? the key/i, /no registered tool/i, /reached by no/i, /every route (?:is|stays) disabled/i, /not (?:yet )?released/i, /no prices?\b/i, /never (?:been )?run against/i, /after the (?:first|second|third|fourth|live)/i, /\bowner\b/i, /one-option choice, is valid/i])
      expect({ stale: String(stale), found: stale.test(section) }).toEqual({ stale: String(stale), found: false })
    // Every registered tool and every enabled route is named, with the wire revisions this version's adapters use.
    for (const tool of TOOLS) expect(section).toContain(`\`inference_${tool.name}\``)
    for (const route of OPENROUTER_CAPABILITIES.routes.filter((item) => item.enabled)) {
      expect(section).toContain(`\`${route.model}\``)
      expect(section).toContain(`\`${route.canary.wireRevision}\``)
    }
    // No superseded wire revision is named.
    for (const revision of section.match(/openrouter-alpha-(?:extractions|decisions)-\d{4}-\d{2}-\d{2}\.\d+/g) ?? [])
      expect(OPENROUTER_CAPABILITIES.routes.some((route) => route.canary.wireRevision === revision)).toBe(true)
  })
})
