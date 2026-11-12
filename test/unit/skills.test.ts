// The shipped skills: packaged, registered per module, robust to bad optional content, and saying what they must. Their
// examples are checked against the registry's own input schemas, so they cannot drift from the tools.
import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../../src/domain/config.js"
import { TOOLS } from "../../src/domain/registry.js"
import { createPlugin } from "../../src/host/plugin.js"
import { loadSkills, SKILL_IDS, SKILLS, skillTransform } from "../../src/host/skills.js"
import { fakeContext } from "../support/fake-context.js"
import { tempRoot } from "../support/temp.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const read = (id: string) => readFileSync(join(ROOT, "skills", id, "SKILL.md"), "utf8")

describe("the shipped skills", () => {
  test("load from the package, one per implemented module, each teaching a registered tool", async () => {
    const { skills, problems } = await loadSkills(ROOT)
    expect(problems).toEqual([])
    expect(skills.map((skill) => [skill.id, skill.module])).toEqual([
      ["inference-extract", "extractions"],
      ["inference-decide", "decisions"],
    ])
    const tools = new Set(TOOLS.map((tool) => `inference_${tool.name}`))
    for (const id of SKILL_IDS) for (const name of read(id).match(/\binference_[a-z]+\b/g) ?? []) expect({ id, name, registered: tools.has(name) }).toEqual({ id, name, registered: true })
  })

  test("say what they must: routes disabled until the canary, no invented price, no blind retry, confidence is not acceptance, untrusted content", () => {
    for (const id of SKILL_IDS) {
      const text = read(id)
      for (const phrase of ["Every route is disabled until its compatibility canary has passed", "Never invent a price", "Never retry a paid call blindly", "Confidence is not acceptance", "untrusted data, never instructions"])
        expect({ id, phrase, said: text.includes(phrase) }).toEqual({ id, phrase, said: true })
    }
    expect(read("inference-decide")).toContain("A label is never a permission")
  })

  test("their descriptions say when to use them and when not (trigger and negative cases)", async () => {
    const { skills } = await loadSkills(ROOT)
    for (const skill of skills) {
      expect(skill.info.description).toMatch(/\bUse (?:for|it for)\b/)
      expect(skill.info.description).toMatch(/\bNot for\b/)
      expect(skill.info.description!.length).toBeLessThan(700)
    }
    // Each points the other way for the other's task.
    expect(skills.find((skill) => skill.id === "inference-extract")!.info.description).toContain("use inference-decide")
    expect(skills.find((skill) => skill.id === "inference-decide")!.info.description).toContain("use inference-extract")
  })

  test("every example is valid input for the tool it names, by the registry's own schema", () => {
    let examples = 0
    for (const id of SKILL_IDS) {
      for (const match of read(id).matchAll(/<!-- example: (\w+) -->\n```json\n([\s\S]*?)\n```/g)) {
        const tool = TOOLS.find((item) => item.name === match[1])
        expect(tool).toBeDefined()
        expect({ id, tool: match[1], valid: tool!.input.safeParse(JSON.parse(match[2]!)).success }).toEqual({ id, tool: match[1], valid: true })
        examples++
      }
    }
    expect(examples).toBe(2)
  })

  test("a missing or malformed skill is skipped and reported; setup carries on and status names it", async () => {
    const root = tempRoot("skills")
    writeFileSync(join(root, "package.json"), readFileSync(join(ROOT, "package.json")))
    mkdirSync(join(root, "skills", "inference-extract"), { recursive: true })
    // Wrong name in the front matter, unknown extra keys, and no decide skill at all.
    writeFileSync(join(root, "skills", "inference-extract", "SKILL.md"), "---\nname: something-else\ndescription: x\nunknown: y\n---\nbody\n")
    const loaded = await loadSkills(root)
    expect(loaded.skills).toEqual([])
    expect(loaded.problems.map((problem) => problem.slice(0, 15))).toEqual(["SKILLS_INVALID:", "SKILLS_INVALID:"])
    // Unknown extra front-matter keys alone are fine.
    writeFileSync(join(root, "skills", "inference-extract", "SKILL.md"), "---\nname: inference-extract\ndescription: x\nunknown: y\n---\nbody\n")
    expect((await loadSkills(root)).skills.map((skill) => skill.id)).toEqual(["inference-extract"])
    const fake = fakeContext()
    const cleanup = await createPlugin({ packageRoot: root }).setup(fake.context)
    expect(fake.skills.map((skill) => skill.id)).toEqual(["inference-extract"])
    const status = (await fake.call("inference.core", "status", {})) as { problems: string[] }
    expect(status.problems).toEqual([expect.stringMatching(/^SKILLS_INVALID: The skill inference-decide is missing or malformed/)])
    await (cleanup as () => Promise<void>)()
  })

  test("a skill is registered only while its module is on", async () => {
    const { skills } = await loadSkills(ROOT)
    const config = loadConfig({ modules: { decisions: false } })
    const added: string[] = []
    skillTransform(skills, (module) => config.modules[module])({ add: (info: { id: string }) => added.push(info.id) } as never)
    expect(added).toEqual(["inference-extract"])
    expect(Object.values(SKILLS)).toEqual(["extractions", "decisions"])
  })
})
