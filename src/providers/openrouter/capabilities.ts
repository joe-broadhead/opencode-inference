import * as z from "zod"
import { Decimal, ModelId, OPERATIONS } from "../../domain/contracts.js"

// The reviewed capability fixture for OpenRouter's alpha Extractions and Decisions routes.
//
// DOCUMENTATION-DERIVED. Every value below was transcribed on 2026-11-11 from OpenRouter's public documentation as
// summarised in the design handoff (§3.1, §7.3, §8.1). None was observed from the live API. No price is recorded,
// because the reviewed sources did not state one, so every quote is `unavailable`. Every route is `enabled: false`
// until its adapter exists and a compatibility canary passes (PR 3 and PR 4). A newer catalog entry never enables a
// route by itself.
//
// This module is data only: no adapter, no catalog refresh and no network. A later release adds the reviewed live
// refresh as a separate, explicit operation and bumps `revision` when this table changes.

const MiB = 1024 * 1024

const Images = z.strictObject({
  maxCount: z.number().int().positive().nullable(),
  maxBytesEach: z.number().int().positive().nullable(),
  maxBytesTotal: z.number().int().positive().nullable(),
  mimeTypes: z.array(z.string()).max(8),
  ordered: z.boolean().describe("Asset references are ordered, so evidence names the right image."),
})

export const RouteCapability = z.strictObject({
  id: z.string().max(128),
  provider: z.literal("openrouter"),
  operation: z.enum(OPERATIONS),
  model: ModelId,
  apiRoute: z.string().max(128),
  endpointProfile: z.string().max(128),
  /** documented: in the current guide; unconfirmed: listed, but its model page was not found during review. */
  status: z.enum(["documented", "unconfirmed"]),
  enabled: z.boolean(),
  inputs: z.strictObject({
    text: z.boolean().nullable(),
    images: Images.nullable().describe("null: not supported, or not reviewed."),
    pdf: z.strictObject({ maxCount: z.number().int().positive() }).nullable(),
    textWithDocument: z.boolean().nullable().describe("Whether substantive text state can accompany a document."),
  }),
  maxRequestBytes: z.number().int().positive().nullable(),
  effectiveContextTokens: z.number().int().positive().nullable().describe("null: not reviewed for this endpoint."),
  fieldTypes: z.array(z.string()).max(16).describe("Documented upstream field kinds, for extraction routes."),
  listItemTypes: z.array(z.string()).max(8),
  questionTypes: z.array(z.string()).max(8).describe("Documented question kinds, for decision routes."),
  nullThreshold: z.strictObject({ supported: z.boolean().nullable(), unsupportedOn: z.array(z.string()).max(8) }),
  pricing: z
    .strictObject({
      revision: z.string().max(64),
      currency: z.literal("USD"),
      perRequest: Decimal.optional(),
      perMillionInputTokens: Decimal.optional(),
      perMillionOutputTokens: Decimal.optional(),
      upperBound: z.boolean(),
    })
    .nullable()
    .describe("null: no price in the reviewed sources."),
  zdr: z.enum(["supported", "unsupported", "unknown"]),
  notes: z.array(z.string().max(512)).max(8),
})
export type RouteCapability = z.infer<typeof RouteCapability>

export const CapabilityFixture = z.strictObject({
  schemaVersion: z.literal(1),
  provider: z.literal("openrouter"),
  revision: z.string().max(64),
  reviewedOn: z.iso.date(),
  basis: z.literal("documentation"),
  verified: z.literal(false),
  notice: z.string().max(1024),
  sources: z.array(z.strictObject({ id: z.string().max(8), title: z.string().max(256), url: z.url() })).max(16),
  routes: z.array(RouteCapability).max(32),
})
export type CapabilityFixture = z.infer<typeof CapabilityFixture>

const EXTRACTIONS = "POST /api/alpha/extractions"
const DECISIONS = "POST /api/alpha/decisions"
const NO_IMAGES = null

export const OPENROUTER_CAPABILITIES: CapabilityFixture = CapabilityFixture.parse({
  schemaVersion: 1,
  provider: "openrouter",
  revision: "openrouter-2026-11-11.1",
  reviewedOn: "2026-11-11",
  basis: "documentation",
  verified: false,
  notice:
    "Transcribed from OpenRouter's public documentation on 2026-11-11. Not verified against the live API. No price was stated, so no quote is available. Every route is disabled until its adapter and a compatibility canary exist.",
  sources: [
    { id: "A1", title: "OpenRouter Extractions announcement, 10 November 2026", url: "https://openrouter.ai/blog/announcements/extractions-api/" },
    { id: "A2", title: "OpenRouter Extractions guide and provider matrix", url: "https://openrouter.ai/docs/guides/community/extractions" },
    { id: "A4", title: "OpenRouter alpha Extractions API reference", url: "https://openrouter.ai/docs/api/api-reference/alphaextractions/submit-an-extractions-request" },
    { id: "D1", title: "OpenRouter alpha Decisions API reference", url: "https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request" },
  ],
  routes: [
    {
      id: "openrouter:extract:cloudflare/clairic",
      provider: "openrouter",
      operation: "extract",
      model: "cloudflare/clairic",
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "documented",
      enabled: false,
      inputs: {
        text: true,
        images: { maxCount: 4, maxBytesEach: 4 * MiB, maxBytesTotal: 8 * MiB, mimeTypes: ["image/png", "image/jpeg", "image/webp"], ordered: true },
        pdf: null,
        textWithDocument: null,
      },
      maxRequestBytes: 16 * MiB,
      effectiveContextTokens: null,
      fieldTypes: ["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"],
      listItemTypes: ["text"],
      questionTypes: [],
      nullThreshold: { supported: true, unsupportedOn: ["list", "estimate", "forecast"] },
      pricing: null,
      zdr: "unknown",
      notes: ["Rich typed fields from text and supported images (A2).", "No direct PDF input: prepare a PDF as text or page images first.", "Image limits: four images, 4 MiB each, 8 MiB decoded in total; 16 MiB request body (A2)."],
    },
    {
      id: "openrouter:extract:scaledown/extract",
      provider: "openrouter",
      operation: "extract",
      model: "scaledown/extract",
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "documented",
      enabled: false,
      inputs: {
        text: true,
        images: { maxCount: 1, maxBytesEach: null, maxBytesTotal: null, mimeTypes: ["image/png", "image/jpeg"], ordered: true },
        pdf: { maxCount: 1 },
        textWithDocument: false,
      },
      maxRequestBytes: null,
      effectiveContextTokens: null,
      fieldTypes: ["text", "list"],
      listItemTypes: ["text"],
      questionTypes: [],
      nullThreshold: { supported: false, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      notes: ["One PDF, PNG or JPEG, or text (A2).", "Text and lists of text only: numbers and dates need an explicit later conversion.", "Does not combine substantive text state with a document; rejects null_threshold."],
    },
    {
      id: "openrouter:extract:inception/mercury-decide",
      provider: "openrouter",
      operation: "extract",
      model: "inception/mercury-decide",
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "documented",
      enabled: false,
      inputs: { text: true, images: NO_IMAGES, pdf: null, textWithDocument: null },
      maxRequestBytes: null,
      effectiveContextTokens: null,
      fieldTypes: ["text", "list"],
      listItemTypes: ["text"],
      questionTypes: [],
      nullThreshold: { supported: null, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      notes: ["Text entities only; no media on the extraction route (A1, A2).", "Enable only after evaluation against a real workload."],
    },
    {
      id: "openrouter:extract:levanto/sage-2",
      provider: "openrouter",
      operation: "extract",
      model: "levanto/sage-2",
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "unconfirmed",
      enabled: false,
      inputs: { text: null, images: NO_IMAGES, pdf: null, textWithDocument: null },
      maxRequestBytes: null,
      effectiveContextTokens: null,
      fieldTypes: [],
      listItemTypes: [],
      questionTypes: [],
      nullThreshold: { supported: null, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      notes: ["Listed in the current guide, but its model page was not found during review. Discovery candidate only."],
    },
    {
      id: "openrouter:decide:typesafe/jev-1.14",
      provider: "openrouter",
      operation: "decide",
      model: "typesafe/jev-1.14",
      apiRoute: DECISIONS,
      endpointProfile: "openrouter-alpha-decisions",
      status: "documented",
      enabled: false,
      inputs: { text: true, images: NO_IMAGES, pdf: null, textWithDocument: null },
      maxRequestBytes: null,
      effectiveContextTokens: null,
      fieldTypes: [],
      listItemTypes: [],
      questionTypes: ["noul", "choice", "score", "box"],
      nullThreshold: { supported: null, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      notes: [
        "Named questions in the request, answers in the response; per-question refusal (D1).",
        "Box answers and image input are documented but not adopted in this fixture: images are recorded as not reviewed.",
        "TypeSafe documents default direct limits of 64k tokens per request and 32k per question; the OpenRouter endpoint's effective limit is not reviewed.",
      ],
    },
  ],
})

/** Days from the review date to `now`, never negative. */
export function fixtureAgeDays(fixture: Pick<CapabilityFixture, "reviewedOn">, now: Date) {
  const reviewed = Date.parse(`${fixture.reviewedOn}T00:00:00Z`)
  return Math.max(0, Math.floor((now.getTime() - reviewed) / 86_400_000))
}

/** After this many days a fixture is reported stale. Alpha routes move quickly. */
export const STALE_AFTER_DAYS = 30
