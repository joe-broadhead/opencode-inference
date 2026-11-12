// Registry parity: the host registration, the tools RPC describe, the Jelly declaration, the generated schemas and the
// docs all expose the same implemented names, shapes and classes, and no planned tool appears on any of them.
// `UPDATE_GENERATED=1 bun test test/unit/registry.test.ts` rewrites package.json's jelly section and the docs blocks.
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { NAMESPACE, PLUGIN_ID } from "../../src/domain/ids.js"
import { actionOf, jsonSchemaOf, NAMESPACE_DESCRIPTION, PLANNED, TOOL_NAMES, TOOLS, type ToolSpec } from "../../src/domain/registry.js"
import { ADAPTERS, createPlugin } from "../../src/host/plugin.js"
import { defaultRules } from "../../src/host/permissions.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { fakeContext } from "../support/fake-context.js"
import { ACCESS, contractsBlock, errorsBlock, hostsBlock, jellyDeclaration, optionsBlock, plannedBlock, routesBlock, rulesBlock, toolsBlock } from "../support/generated.js"
import { declarationProblems, docProblems, effectFromRules, readPackage } from "../support/jelly-kit.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const ROOT_URL = new URL("../../", import.meta.url)
const UPDATE = process.env.UPDATE_GENERATED === "1"
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8")

function checkBlock(file: string, name: string, body: string) {
  const open = `<!-- generated:${name} -->`
  const close = `<!-- /generated:${name} -->`
  const text = read(file)
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  expect({ file, name, markers: start !== -1 && end > start }).toEqual({ file, name, markers: true })
  const expected = `${text.slice(0, start + open.length)}\n\n${body}\n\n${text.slice(end)}`
  if (UPDATE) {
    if (expected !== text) writeFileSync(`${ROOT}${file}`, expected)
    return
  }
  expect(text, `${file}: the ${name} block is stale; run UPDATE_GENERATED=1 bun test test/unit/registry.test.ts`).toBe(expected)
}

async function registered() {
  const fake = fakeContext({ sessions: { ses_1: { agent: "build" } } })
  const cleanup = (await createPlugin({ packageRoot: ROOT }).setup(fake.context)) as () => Promise<void>
  const describe = (await fake.call(TOOLS_RPC_ID, "describe", { sessionID: "ses_1" })) as { id: string; methods: Record<string, unknown>[] }
  const contract = fake.rpc.get(TOOLS_RPC_ID)!.contract
  await cleanup()
  return { fake, describe, contract }
}

describe("registry parity", () => {
  test("the host registration is the registry: names, descriptions, schemas, namespace and permission actions", async () => {
    const { fake } = await registered()
    expect(fake.namespaces).toEqual([{ name: NAMESPACE, description: NAMESPACE_DESCRIPTION }])
    expect(fake.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES])
    for (const [index, tool] of fake.tools.entries()) {
      const spec = TOOLS[index]!
      expect(tool.description).toBe(spec.description)
      expect(tool.input).toBe(spec.input)
      expect(tool.output).toBe(spec.output)
      expect(tool.options).toEqual({ namespace: NAMESPACE, permission: actionOf(spec.name) })
    }
  })

  test("the tools RPC describe lists the same methods, with their classes, actions and JSON Schemas", async () => {
    const { describe, contract } = await registered()
    expect(describe.id).toBe(`${PLUGIN_ID}.tools`)
    expect(describe.methods.map((method) => method.name)).toEqual([...TOOL_NAMES])
    for (const [index, method] of describe.methods.entries()) {
      const spec = TOOLS[index]!
      expect(method).toMatchObject({ kind: "plugin", class: spec.class, action: actionOf(spec.name), available: true, permission: "allow", description: spec.description })
      expect(method.input).toEqual(jsonSchemaOf(spec.input, "input"))
      expect(method.output).toEqual(jsonSchemaOf(spec.output, "output"))
    }
    expect(Object.keys(contract.methods).sort()).toEqual(["describe", ...TOOL_NAMES].sort())
  })

  test("no planned tool is registered, described, declared or given a rule", async () => {
    const { fake, describe, contract } = await registered()
    const jelly = readPackage(ROOT_URL).jelly!
    for (const operation of PLANNED) {
      expect(fake.tools.map((tool) => tool.name)).not.toContain(operation.name)
      expect(describe.methods.map((method) => method.name)).not.toContain(operation.name)
      expect(Object.keys(contract.methods)).not.toContain(operation.name)
      expect(jelly.tools!.map((tool) => tool.permission)).not.toContain(operation.tool)
      for (const access of ACCESS) expect(defaultRules(access).map((rule) => rule.action)).not.toContain(operation.tool)
    }
  })

  test("the read tools are strictly local; extract is the one send, with every effect and an adapter", () => {
    const LOCAL = { network: false, uploadsSource: false, billable: false, readsFiles: false }
    expect(TOOLS.map((tool) => ({ name: tool.name, class: tool.class, effects: tool.effects }))).toEqual([
      { name: "status", class: "read", effects: LOCAL },
      { name: "capabilities", class: "read", effects: LOCAL },
      { name: "plan", class: "read", effects: LOCAL },
      { name: "extract", class: "send", effects: { network: true, uploadsSource: true, billable: true, readsFiles: true } },
    ])
    for (const tool of TOOLS as readonly ToolSpec[]) if (tool.class !== "read") expect(ADAPTERS[tool.name]?.operation).toBe(tool.operation!)
    expect(PLANNED.map((operation) => operation.name)).toEqual(["decide", "read"])
  })
})

describe("the Jelly declaration", () => {
  test("is the registry's projection", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, unknown>
    const expected = jellyDeclaration()
    if (UPDATE && JSON.stringify(pkg.jelly) !== JSON.stringify(expected)) writeFileSync(`${ROOT}package.json`, `${JSON.stringify({ ...pkg, jelly: expected }, null, 2)}\n`)
    else expect(pkg.jelly).toEqual(expected)
  })

  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    expect(declarationProblems(ROOT_URL, { effectOf: effectFromRules(defaultRules("all")), registered: TOOLS.map((tool) => actionOf(tool.name)) })).toEqual([])
    expect(docProblems(ROOT_URL)).toEqual([])
  })
})

describe("the generated docs", () => {
  test("docs/architecture.md", () => {
    checkBlock("docs/architecture.md", "tools", toolsBlock())
    checkBlock("docs/architecture.md", "planned", plannedBlock())
    checkBlock("docs/architecture.md", "routes", routesBlock())
    checkBlock("docs/architecture.md", "contracts", contractsBlock())
  })

  test("docs/configuration.md", () => {
    checkBlock("docs/configuration.md", "options", optionsBlock())
    for (const access of ACCESS) checkBlock("docs/configuration.md", `rules-${access}`, rulesBlock(access))
    checkBlock("docs/configuration.md", "errors", errorsBlock())
  })

  test("README.md and docs/scripting.md", () => {
    checkBlock("README.md", "hosts", hostsBlock())
    checkBlock("README.md", "tools", toolsBlock())
    checkBlock("docs/scripting.md", "tools", toolsBlock())
  })
})
