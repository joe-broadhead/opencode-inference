// What the registry projects into package.json and the docs. test/unit/registry.test.ts compares the files with these;
// `UPDATE_GENERATED=1 bun test test/unit/registry.test.ts` rewrites them.
import { CONTRACTS } from "../../src/domain/contracts.js"
import { DEFAULT_PROFILES, DEFAULTS, OPTIONS_JSON_SCHEMA } from "../../src/domain/config.js"
import { FAILURES } from "../../src/domain/errors.js"
import { ACCESS_VALUES, INTEGRATION_ID, NAMESPACE, PLUGIN_ID, type Access } from "../../src/domain/ids.js"
import { actionOf, PLANNED, TOOLS } from "../../src/domain/registry.js"
import { defaultRules, effectOf } from "../../src/host/permissions.js"
import { NEXT_STEPS, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { HOST_RANGE, TESTED_HOSTS } from "../../src/host/versions.js"
import { OPENROUTER_CAPABILITIES } from "../../src/providers/openrouter/capabilities.js"

/** The `jelly` section of package.json. */
export const jellyDeclaration = () => ({
  title: "Inference",
  summary: "Typed extraction and bounded decisions over supplied content, planned locally.",
  icon: "assets/icon.svg",
  tools: TOOLS.map((tool) => ({ name: `${NAMESPACE}.${tool.name}`, permission: actionOf(tool.name), effect: effectOf(tool.class, "all"), readOnly: tool.class === "read" })),
  skills: [] as string[],
  rpc: [] as unknown[],
  views: [] as unknown[],
  signIns: [
    {
      id: "openrouter",
      label: "OpenRouter",
      integration: INTEGRATION_ID,
      required: false,
      help: { url: "https://openrouter.ai/settings/keys", label: "Create an OpenRouter API key" },
    },
  ],
  contributes: {
    homeFeeds: [] as unknown[],
    homeWidgets: [] as unknown[],
    workKinds: [] as unknown[],
    settings: [
      {
        key: "access",
        label: "Access",
        type: "string",
        default: DEFAULTS.access,
        description: "all, ask-changes or read-only. Generates default rules for agents with a base allow rule; the three local reads always run, and extract follows access.",
      },
    ],
  },
})

const yes = (value: boolean) => (value ? "yes" : "no")

/** docs/architecture.md: the registered tools on every surface. */
export const toolsBlock = () =>
  [
    "| Tool | Host tool and permission | Code Mode | Tools RPC method | Jobs manifest | Class | Network | Uploads source | Billable |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...TOOLS.map((tool) =>
      [
        `\`${NAMESPACE}.${tool.name}\``,
        `\`${actionOf(tool.name)}\``,
        `\`tools.${NAMESPACE}.${tool.name}(input)\``,
        `\`${TOOLS_RPC_ID}/${tool.name}\``,
        `\`${PLUGIN_ID}.${tool.name}\``,
        tool.class,
        yes(tool.effects.network),
        yes(tool.effects.uploadsSource),
        yes(tool.effects.billable),
      ].join(" | "),
    ).map((row) => `| ${row} |`),
  ].join("\n")

/** docs/architecture.md: the reserved operations, which are not registered. */
export const plannedBlock = () =>
  [
    "| Operation | Reserved tool | Class | Module | Registered |",
    "| --- | --- | --- | --- | --- |",
    ...PLANNED.map((operation) => `| \`${NAMESPACE}.${operation.name}\` | \`${operation.tool}\` | ${operation.class} | \`${operation.module}\` | no |`),
  ].join("\n")

/** docs/architecture.md: the fixture's routes. */
export const routesBlock = () =>
  [
    `Fixture \`${OPENROUTER_CAPABILITIES.revision}\`, reviewed ${OPENROUTER_CAPABILITIES.reviewedOn}, ${OPENROUTER_CAPABILITIES.basis}-derived, verified: ${OPENROUTER_CAPABILITIES.verified}.`,
    "",
    "| Model | Operation | Route | Status | Enabled | Text | Images | PDF | Field or question types | Price |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...OPENROUTER_CAPABILITIES.routes.map((route) => {
      const images = route.inputs.images ? `${route.inputs.images.maxCount ?? "?"} (${route.inputs.images.mimeTypes.join(", ")})` : "no"
      const types = route.operation === "decide" ? route.questionTypes : route.fieldTypes
      return `| \`${route.model}\` | ${route.operation} | \`${route.apiRoute}\` | ${route.status} | ${yes(route.enabled)} | ${route.inputs.text === null ? "unknown" : yes(route.inputs.text)} | ${images} | ${route.inputs.pdf ? `${route.inputs.pdf.maxCount} file` : "no"} | ${types.join(", ") || "unknown"} | ${route.pricing ? route.pricing.revision : "unknown"} |`
    }),
  ].join("\n")

/** docs/architecture.md: the public contracts. */
export const contractsBlock = () => Object.keys(CONTRACTS).map((name) => `- \`${name}\``).join("\n")

/** docs/configuration.md: the default rules for one access value. */
export const rulesBlock = (access: Access) =>
  [`\`access: "${access}"\``, "", "| Action | Resource | Effect |", "| --- | --- | --- |", ...defaultRules(access).map((rule) => `| \`${rule.action}\` | \`${rule.resource}\` | \`${rule.effect}\` |`)].join("\n")

/** docs/configuration.md: the options and their defaults. */
export const optionsBlock = () => {
  const properties = (OPTIONS_JSON_SCHEMA as { properties: Record<string, { properties?: Record<string, unknown> }> }).properties
  const defaults: Record<string, unknown> = { ...DEFAULTS, profiles: DEFAULT_PROFILES }
  return [
    "| Option | Default |",
    "| --- | --- |",
    ...Object.keys(properties).flatMap((key) => {
      const nested = properties[key]!.properties
      const value = defaults[key]
      if (nested && key !== "profiles")
        return Object.keys(nested).map((child) => `| \`${key}.${child}\` | \`${JSON.stringify((value as Record<string, unknown> | undefined)?.[child])}\` |`)
      return [`| \`${key}\` | \`${JSON.stringify(value)}\` |`]
    }),
  ].join("\n")
}

/** docs/configuration.md: every code a caller can see. */
export const errorsBlock = () =>
  [
    "| Code | What happened | Next step |",
    "| --- | --- | --- |",
    ...Object.entries(FAILURES).map(([code, [what, next]]) => `| \`${code}\` | ${what} | ${next} |`),
    ...Object.entries(NEXT_STEPS)
      .filter(([code]) => !(code in FAILURES))
      .map(([code, next]) => `| \`${code}\` | Refused by the tools RPC. | ${next} |`),
  ].join("\n")

/** README and docs: the host line. */
export const hostsBlock = () => `OpenCode \`${HOST_RANGE}\`, tested on ${TESTED_HOSTS.join(", ")}.`

export const ACCESS = ACCESS_VALUES
