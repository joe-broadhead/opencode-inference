import * as z from "zod"
import { Decimal, ModelId, ProfileName } from "./contracts.js"
import { InferenceError } from "./errors.js"
import { ACCESS_VALUES, MODULES, type Access, type Module } from "./ids.js"

// The trusted plugin options (handoff §12), strict. Secrets are never options: a key is added through /connect and read
// only at the transport boundary. A tool input can narrow these limits, never widen them.

/** The profiles used when `profiles` is not set. Setting `profiles` replaces them. */
export const DEFAULT_PROFILES = {
  "extract-typed": { model: "cloudflare/clairic" },
  "extract-pdf": { model: "scaledown/extract" },
  "decide-text": { model: "typesafe/jev-1.14" },
} as const satisfies Record<string, { model: string }>

export const DEFAULTS = {
  access: "all",
  modules: { extractions: true, decisions: true, understanding: false },
  routing: { mode: "explicit", fallbacks: [] as string[] },
  limits: { concurrency: 2, maxFields: 32, deadlineMs: 60_000 },
  spend: { requestUsd: "0.05", sessionUsd: "1.00", rolling24hUsd: "5.00", requirePricedRoute: true, requireUpperBound: false },
  data: { requireZdr: false },
  cache: { enabled: false },
  allowUntestedHost: false,
} as const

/** Option names that look like a secret are refused with a pointer to /connect, never echoed. */
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|credential|authorization|bearer)/i

const Options = z.strictObject({
  access: z.enum(ACCESS_VALUES).optional(),
  modules: z.strictObject({ extractions: z.boolean().optional(), decisions: z.boolean().optional(), understanding: z.boolean().optional() }).optional(),
  profiles: z
    .record(ProfileName, z.strictObject({ model: ModelId }))
    .refine((value) => Object.keys(value).length <= 32, "at most 32 profiles")
    .optional(),
  routing: z
    .strictObject({
      mode: z.literal("explicit").optional(),
      // Automatic fallback is disabled until evaluated (§3.2, PR 4): only an empty list is accepted.
      fallbacks: z.array(ModelId).max(0, "must be empty: automatic fallback is not supported").optional(),
    })
    .optional(),
  limits: z
    .strictObject({
      concurrency: z.number().int().min(1).max(8).optional(),
      maxFields: z.number().int().min(1).max(64).optional(),
      deadlineMs: z.number().int().min(1000).max(600_000).optional(),
    })
    .optional(),
  spend: z
    .strictObject({
      requestUsd: Decimal.optional(),
      sessionUsd: Decimal.optional(),
      rolling24hUsd: Decimal.optional(),
      requirePricedRoute: z.boolean().optional(),
      requireUpperBound: z.boolean().optional(),
    })
    .optional(),
  data: z.strictObject({ requireZdr: z.boolean().optional() }).optional(),
  cache: z.strictObject({ enabled: z.literal(false, "must be false: the result cache is not implemented yet").optional() }).optional(),
  allowUntestedHost: z.boolean().optional(),
})

export type Options = z.input<typeof Options>

export interface Config {
  readonly access: Access
  readonly modules: { readonly [M in Module]: boolean }
  readonly profiles: Readonly<Record<string, { readonly model: string }>>
  readonly routing: { readonly mode: "explicit"; readonly fallbacks: readonly string[] }
  readonly limits: { readonly concurrency: number; readonly maxFields: number; readonly deadlineMs: number }
  readonly spend: {
    readonly requestUsd: string
    readonly sessionUsd: string
    readonly rolling24hUsd: string
    readonly requirePricedRoute: boolean
    readonly requireUpperBound: boolean
  }
  readonly data: { readonly requireZdr: boolean }
  readonly cache: { readonly enabled: boolean }
  readonly allowUntestedHost: boolean
}

/** The model a configured profile names, or undefined. Looked up without reaching a prototype. */
export const profileModel = (config: Pick<Config, "profiles">, name: string) => new Map(Object.entries(config.profiles)).get(name)?.model

/** The keys of a value, at any depth, that look like secrets. Only key paths are reported, never values. */
function secretPaths(value: unknown, path: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [...(SECRET_KEY.test(key) ? [[...path, key].join(".")] : []), ...secretPaths(child, [...path, key])])
}

/** Validates the plugin options. An invalid option fails setup with every offending key named, never its value. */
export function loadConfig(options: unknown): Config {
  const secrets = secretPaths(options)
  if (secrets.length > 0)
    throw new InferenceError(
      "OPTIONS_INVALID",
      `The plugin options contain ${secrets.map((path) => `options.${path}`).join(", ")}, which look like secrets; keys are never plugin options.`,
      "Remove them from opencode.json and add the OpenRouter key with /connect, choosing OpenRouter for Inference, then restart OpenCode.",
    )
  const parsed = Options.safeParse(options ?? {})
  if (!parsed.success) {
    const problems = parsed.error.issues.flatMap((issue) => {
      const path = ["options", ...issue.path.map(String)].join(".")
      return issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => `${path}.${key} is not an Inference option`)
        : [`${path} ${issue.message.replace(/^Invalid input: /, "is invalid: ")}`]
    })
    throw new InferenceError("OPTIONS_INVALID", `The plugin options are invalid: ${problems.join("; ")}.`)
  }
  const value = parsed.data
  return {
    access: value.access ?? DEFAULTS.access,
    modules: Object.fromEntries(MODULES.map((name) => [name, value.modules?.[name] ?? DEFAULTS.modules[name]])) as Config["modules"],
    profiles: value.profiles ?? DEFAULT_PROFILES,
    routing: { mode: "explicit", fallbacks: [] },
    limits: { ...DEFAULTS.limits, ...value.limits },
    spend: { ...DEFAULTS.spend, ...value.spend },
    data: { ...DEFAULTS.data, ...value.data },
    cache: { enabled: false },
    allowUntestedHost: value.allowUntestedHost ?? DEFAULTS.allowUntestedHost,
  }
}

/** The options as JSON Schema, for docs/configuration.md. */
export const OPTIONS_JSON_SCHEMA = z.toJSONSchema(Options, { io: "input" }) as Record<string, unknown>
