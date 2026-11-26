import * as z from "zod"
import { ACCESS_LEVELS, DEFAULT_ACCESS, type AccessLevel } from "@we-the-rebel-alliance/plugin-contract/access"
import { AcceptanceProfile, automaticProblem, QuestionSet } from "./acceptance.js"
import { Decimal, MAX_KEYS, ModelId, ProfileName, VersionedName } from "./contracts.js"
import { InferenceError } from "./errors.js"
import { MODULES, type Module } from "./ids.js"

// The trusted plugin options, strict. Secrets are never options: a key is added through an account sign-in and read
// only at the transport boundary. A method input can narrow these limits, never widen them.

/** The profiles used when `profiles` is not set. Setting `profiles` replaces them. */
export const DEFAULT_PROFILES = {
  "extract-typed": { model: "cloudflare/clairic" },
  "extract-pdf": { model: "scaledown/extract" },
  "decide-text": { model: "typesafe/jev-1.14" },
} as const satisfies Record<string, { model: string }>

export const DEFAULTS = {
  access: DEFAULT_ACCESS,
  modules: { extractions: true, decisions: true, understanding: false },
  limits: { concurrency: 2, maxFields: 32, deadlineMs: 60_000 },
  // No spend cap unless one is set: each call still reports its cost. requirePricedRoute is a truthful-cost guard, not a
  // limit, so it stays on.
  spend: { requestUsd: null, sessionUsd: null, rolling24hUsd: null, requirePricedRoute: true, requireUpperBound: false },
  data: { requireZdr: false },
  allowUntestedHost: false,
  questionSets: {} as Record<string, never>,
  acceptanceProfiles: {} as Record<string, never>,
} as const

/** Option names that look like a secret are refused with a pointer to sign-in, never echoed. */
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|credential|authorization|bearer)/i

/** The account profile: this plugin's key belongs to the alias, so a profile has no fields of its own. */
export const AccountProfileSchema = z.strictObject({})

/** Every option the plugin reads, including the accounts map the contract module owns. */
export const Options = z.strictObject({
  access: z.enum(ACCESS_LEVELS).default(DEFAULTS.access).describe("How much the plugin's methods may do without asking."),
  accounts: z
    .record(z.string(), AccountProfileSchema)
    .describe("One profile per account alias; a sign-in holds the OpenRouter key for that alias.")
    .optional(),
  allowUntestedHost: z.boolean().default(DEFAULTS.allowUntestedHost).describe("Start outside the tested OpenCode range."),
  modules: z
    .strictObject({ extractions: z.boolean().default(true), decisions: z.boolean().default(true), understanding: z.boolean().default(false) })
    .describe("Which operations are on. understanding is reserved and has no method in this version.")
    .optional(),
  profiles: z
    .record(ProfileName, z.strictObject({ model: ModelId }))
    .refine((value) => Object.keys(value).length <= 32, "at most 32 profiles")
    .describe("Task profiles, each naming a reviewed model. Setting it replaces the built-in profiles.")
    .optional(),
  limits: z
    .strictObject({
      concurrency: z.number().int().min(1).max(8).describe("Requests in flight at once, from 1 to 8."),
      maxFields: z.number().int().min(1).max(64).describe("The most fields or questions one call may name, up to 64."),
      deadlineMs: z.number().int().min(1000).max(600_000).describe("The deadline for one provider call, from one second to ten minutes."),
    })
    .partial()
    .describe("The trusted limits a method input can only lower.")
    .optional(),
  spend: z
    .strictObject({
      requestUsd: Decimal.nullable().describe("The most one call may reserve, in USD; null for no cap."),
      sessionUsd: Decimal.nullable().describe("The most one session may spend, in USD; null for no cap."),
      rolling24hUsd: Decimal.nullable().describe("The most any rolling 24 hours may spend, in USD; null for no cap."),
      requirePricedRoute: z.boolean().describe("Refuse a route with no price."),
      requireUpperBound: z.boolean().describe("Refuse a route whose price is only an estimate."),
    })
    .partial()
    .describe("The spend caps and the truthful-cost guards.")
    .optional(),
  data: z.strictObject({ requireZdr: z.boolean().describe("Refuse a route that does not document zero data retention.") }).partial().describe("Data-handling options.").optional(),
  questionSets: z
    .record(VersionedName, QuestionSet)
    .refine((value) => Object.keys(value).length <= 32, "at most 32 question sets")
    .refine((value) => Object.values(value).every((set) => Object.keys(set.questions).length >= 1 && Object.keys(set.questions).length <= MAX_KEYS), `each question set has 1 to ${MAX_KEYS} questions`)
    .describe("Versioned question sets, by name, that decide may use instead of inline questions.")
    .optional(),
  acceptanceProfiles: z
    .record(VersionedName, AcceptanceProfile)
    .refine((value) => Object.keys(value).length <= 32, "at most 32 acceptance profiles")
    .refine((value) => !Object.keys(value).includes("review-first-v1"), "review-first-v1 is built in and cannot be redefined")
    .describe("Versioned acceptance profiles, by name. review-first-v1 is built in.")
    .optional(),
})

export type Options = z.input<typeof Options>

export interface Config {
  readonly access: AccessLevel
  readonly modules: { readonly [M in Module]: boolean }
  readonly profiles: Readonly<Record<string, { readonly model: string }>>
  readonly limits: { readonly concurrency: number; readonly maxFields: number; readonly deadlineMs: number }
  /** The spend caps: `null` is no cap (the default). */
  readonly spend: {
    readonly requestUsd: string | null
    readonly sessionUsd: string | null
    readonly rolling24hUsd: string | null
    readonly requirePricedRoute: boolean
    readonly requireUpperBound: boolean
  }
  readonly data: { readonly requireZdr: boolean }
  readonly allowUntestedHost: boolean
  /** Versioned question sets, by name. */
  readonly questionSets: Readonly<Record<string, QuestionSet>>
  /** Versioned acceptance profiles, by name; review-first-v1 is built in. */
  readonly acceptanceProfiles: Readonly<Record<string, AcceptanceProfile>>
}

/** A configured question set by name, or undefined. */
export const questionSetOf = (config: Pick<Config, "questionSets">, name: string) => new Map(Object.entries(config.questionSets)).get(name)
/** A configured acceptance profile by name, or undefined. */
export const acceptanceProfileOf = (config: Pick<Config, "acceptanceProfiles">, name: string) => new Map(Object.entries(config.acceptanceProfiles)).get(name)

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
      "Remove them from opencode.json and sign the account in with /connect, then restart OpenCode.",
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
  const questionSets = value.questionSets ?? {}
  const acceptanceProfiles = value.acceptanceProfiles ?? {}
  const untrusted = Object.entries(acceptanceProfiles).flatMap(([name, profile]) => {
    const problem = automaticProblem(name, profile, questionSets)
    return problem ? [`options.acceptanceProfiles.${name}: ${problem}`] : []
  })
  if (untrusted.length)
    throw new InferenceError(
      "OPTIONS_INVALID",
      `The plugin options are invalid: ${untrusted.join("; ")}.`,
      "Evaluate the profile with scripts/evaluate-decisions.ts on held-out data and put its report in the profile, or set its mode to review.",
    )
  return {
    access: value.access,
    modules: Object.fromEntries(MODULES.map((name) => [name, value.modules?.[name] ?? DEFAULTS.modules[name]])) as Config["modules"],
    profiles: value.profiles ?? DEFAULT_PROFILES,
    limits: { ...DEFAULTS.limits, ...value.limits },
    spend: { ...DEFAULTS.spend, ...value.spend },
    data: { ...DEFAULTS.data, ...value.data },
    allowUntestedHost: value.allowUntestedHost,
    questionSets,
    acceptanceProfiles,
  }
}

/** The options as JSON Schema: the manifest carries exactly this, and a test keeps the two equal. */
export const OPTIONS_JSON_SCHEMA = z.toJSONSchema(Options, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
