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
