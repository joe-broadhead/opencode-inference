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
  canonicalSlug: ModelId.nullable().describe(
    "The dated model an answer names for this route, from the catalog's canonical_slug on the review date (source C1), such as cloudflare/clairic-20261029. An answer is accepted from exactly this or the route's model id; anything else, a newer slug included, is another model. null: not reviewed, so only the model id is accepted.",
  ),
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
  contextAllowance: z
    .strictObject({
      tokens: z.number().int().nonnegative().describe("Tokens the endpoint's own prompt template and overhead add to every request."),
      source: z.string().min(1).max(256).describe("Where the provider documents this allowance, such as a source id in `sources`."),
    })
    .nullable()
    .describe(
      "The documented template and overhead allowance. The only way effectiveContextTokens becomes usable: a server-side template adds tokens the request does not contain, so without it a request cannot be shown to fit and is refused. null: not documented.",
    ),
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
      upperBound: z.boolean().describe("For a per-request price only: true when that price is the whole charge. It never makes a per-token price a ceiling."),
      ceiling: z
        .strictObject({ amount: Decimal, source: z.string().min(1).max(256).describe("Where the provider documents this maximum, such as a source id in `sources`.") })
        .optional()
        .describe(
          "A provider-documented maximum charge per request. The only way a per-token price becomes an upper bound: token counts cannot be bounded locally (a server-side prompt template adds tokens the request does not contain), so without it a per-token price is an estimate and the call reserves the whole per-request budget.",
        ),
    })
    .nullable()
    .describe("null: no price in the reviewed sources."),
  zdr: z.enum(["supported", "unsupported", "unknown"]),
  canary: z
    .strictObject({
      status: z.enum(["not_run", "passed", "failed"]),
      on: z.iso.date().nullable(),
      reports: z
        .array(z.string().regex(/^(?:extractions|decisions)-\d{8}T\d{6}Z\.json$/))
        .max(8)
        .optional()
        .describe("The redacted canary reports that show the pass, by file name: the request canary and the malformed-request canary."),
      wireRevision: z.string().max(64).optional().describe("The adapter's WIRE_REVISION the canary passed against. Another revision needs the canary again."),
    })
    .describe("The opt-in compatibility canary against the live API (scripts/canary-*.ts). A route is enabled only after it passed."),
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
  catalog: z
    .strictObject({ checkedOn: z.iso.date().nullable(), status: z.enum(["not_checked", "in_step", "drift"]) })
    .describe("The last comparison with OpenRouter's model catalog (catalog.ts). Drift is reported, never acted on: a new model is a disabled candidate."),
  routes: z
    .array(RouteCapability)
    .max(32)
    .superRefine((routes, context) => {
      for (const route of routes) {
        if (route.enabled && route.canary.status !== "passed") context.addIssue({ code: "custom", message: `${route.model} is enabled without a passed compatibility canary` })
        // A pass names its evidence: the request and malformed-request reports, and the wire revision they ran against.
        if (route.enabled && ((route.canary.reports?.length ?? 0) < 2 || route.canary.wireRevision === undefined))
          context.addIssue({ code: "custom", message: `${route.model} is enabled without its canary reports and wire revision` })
      }
    }),
})
export type CapabilityFixture = z.infer<typeof CapabilityFixture>

const EXTRACTIONS = "POST /api/alpha/extractions"
const DECISIONS = "POST /api/alpha/decisions"
const NO_IMAGES = null
const NOT_RUN = { status: "not_run", on: null } as const

/**
 * Clairic's documented image input (A2): four PNG, JPEG or WebP images, 4 MiB each, 8 MiB decoded in total, read in
 * order. A route takes images only while its `inputs.images` holds this, which needs an image canary; the image canary
 * and the adapter's tests use it directly.
 */
export const CLAIRIC_DOCUMENTED_IMAGES = { maxCount: 4, maxBytesEach: 4 * MiB, maxBytesTotal: 8 * MiB, mimeTypes: ["image/png", "image/jpeg", "image/webp"], ordered: true }

export const OPENROUTER_CAPABILITIES: CapabilityFixture = CapabilityFixture.parse({
  schemaVersion: 1,
  provider: "openrouter",
  revision: "openrouter-2026-11-12.4",
  reviewedOn: "2026-11-11",
  basis: "documentation",
  verified: false,
  notice:
    "Transcribed from OpenRouter's public documentation on 2026-11-11, with canonical slugs from its catalog on 2026-11-12. A route is enabled only after its compatibility canary has passed against the live API: its canary names the reports and the wire revision. A route without a passed canary or a price stays disabled.",
  sources: [
    { id: "A1", title: "OpenRouter Extractions announcement, 10 November 2026", url: "https://openrouter.ai/blog/announcements/extractions-api/" },
    { id: "A2", title: "OpenRouter Extractions guide and provider matrix", url: "https://openrouter.ai/docs/guides/community/extractions" },
    { id: "A4", title: "OpenRouter alpha Extractions API reference", url: "https://openrouter.ai/docs/api/api-reference/alphaextractions/submit-an-extractions-request" },
    { id: "D1", title: "OpenRouter alpha Decisions API reference", url: "https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request" },
    { id: "C1", title: "OpenRouter model catalog (canonical slugs), read 2026-11-12", url: "https://openrouter.ai/api/v1/models" },
    { id: "T1", title: "TypeSafe models page: Jev's context length, measured over the state and questions, read 2026-11-12", url: "https://docs.typesafe.ai/models.md" },
  ],
  catalog: { checkedOn: null, status: "not_checked" },
  routes: [
    {
      id: "openrouter:extract:cloudflare/clairic",
      provider: "openrouter",
      operation: "extract",
      model: "cloudflare/clairic",
      canonicalSlug: "cloudflare/clairic-20261029",
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "documented",
      // Enabled for text after the canary of 2026-11-12 (see canary). Images are documented (CLAIRIC_DOCUMENTED_IMAGES)
      // but the canary observed text only, so they stay unreviewed (null) until an image canary passes; PDF is not a
      // Clairic input.
      enabled: true,
      inputs: {
        text: true,
        images: null,
        pdf: null,
        textWithDocument: null,
      },
      maxRequestBytes: 16 * MiB,
      // The endpoint's context_length in the catalog (C1), informational: extraction never gates on it. A prefix-only read
      // is reported by the provider as truncated, which is partial coverage and a review reason. No allowance is published.
      effectiveContextTokens: 65536,
      contextAllowance: null,
      // duration is documented (A2) but not adopted: its answer is a number in a unit the result cannot carry yet, so
      // plan reports it FIELD_TYPE_UNSUPPORTED before anything is read.
      fieldTypes: ["text", "number", "date", "time", "datetime", "list", "estimate", "forecast"],
      listItemTypes: ["text"],
      questionTypes: [],
      nullThreshold: { supported: true, unsupportedOn: ["list", "estimate", "forecast"] },
      // The catalog's per-token prices (C1, 2026-11-12): prompt 0.0000001 USD per token, completion 0. They reproduce the
      // canary's reported cost exactly (125 input tokens: 0.0000125). No ceiling is documented, so a call reserves the
      // whole per-request budget.
      pricing: { revision: "openrouter-catalog-2026-11-12", currency: "USD", perMillionInputTokens: "0.1", perMillionOutputTokens: "0", upperBound: false },
      zdr: "unknown",
      canary: {
        status: "passed",
        on: "2026-11-12",
        reports: ["extractions-20261112T215014Z.json", "extractions-20261112T225713Z.json"],
        wireRevision: "openrouter-alpha-extractions-2026-11-12.2",
      },
      notes: [
        "Rich typed fields from text (A2). duration is documented but not adopted in this version.",
        "Enabled for text only: the canary observed text. Images (four, 4 MiB each, 8 MiB decoded in total; A2) stay disabled until an image canary passes.",
        "No direct PDF input: prepare a PDF as text first.",
      ],
    },
    {
      id: "openrouter:extract:scaledown/extract",
      provider: "openrouter",
      operation: "extract",
      model: "scaledown/extract",
      canonicalSlug: "scaledown/extract-20260928",
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
      contextAllowance: null,
      fieldTypes: ["text", "list"],
      listItemTypes: ["text"],
      questionTypes: [],
      nullThreshold: { supported: false, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      canary: NOT_RUN,
      notes: ["One PDF, PNG or JPEG, or text (A2).", "Text and lists of text only: numbers and dates need an explicit later conversion.", "Does not combine substantive text state with a document; rejects null_threshold."],
    },
    {
      id: "openrouter:extract:inception/mercury-decide",
      provider: "openrouter",
      operation: "extract",
      model: "inception/mercury-decide",
      canonicalSlug: null,
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "documented",
      enabled: false,
      inputs: { text: true, images: NO_IMAGES, pdf: null, textWithDocument: null },
      maxRequestBytes: null,
      effectiveContextTokens: null,
      contextAllowance: null,
      fieldTypes: ["text", "list"],
      listItemTypes: ["text"],
      questionTypes: [],
      nullThreshold: { supported: null, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      canary: NOT_RUN,
      notes: ["Text entities only; no media on the extraction route (A1, A2).", "Enable only after evaluation against a real workload."],
    },
    {
      id: "openrouter:extract:levanto/sage-2",
      provider: "openrouter",
      operation: "extract",
      model: "levanto/sage-2",
      canonicalSlug: null,
      apiRoute: EXTRACTIONS,
      endpointProfile: "openrouter-alpha-extractions",
      status: "unconfirmed",
      enabled: false,
      inputs: { text: null, images: NO_IMAGES, pdf: null, textWithDocument: null },
      maxRequestBytes: null,
      effectiveContextTokens: null,
      contextAllowance: null,
      fieldTypes: [],
      listItemTypes: [],
      questionTypes: [],
      nullThreshold: { supported: null, unsupportedOn: [] },
      pricing: null,
      zdr: "unknown",
      canary: NOT_RUN,
      notes: ["Listed in the current guide, but its model page was not found during review. Discovery candidate only."],
    },
    {
      id: "openrouter:decide:typesafe/jev-1.14",
      provider: "openrouter",
      operation: "decide",
      model: "typesafe/jev-1.14",
      canonicalSlug: "typesafe/jev-1.14-20261014",
      apiRoute: DECISIONS,
      endpointProfile: "openrouter-alpha-decisions",
      status: "documented",
      // Enabled for noul, choice and score questions over text after the canary of 2026-11-12 (see canary).
      enabled: true,
      inputs: { text: true, images: NO_IMAGES, pdf: null, textWithDocument: null },
      maxRequestBytes: null,
      // TypeSafe's default limits (T1): 64k tokens for the state plus all questions, 32k for the state plus any one
      // question; 262k only with a long-context header, which OpenRouter's guide says only image requests get. 32000 reads
      // "32k" at its lower value and bounds both limits at once. TypeSafe measures them over the state and questions,
      // exactly what the adapter counts (in UTF-8 bytes, never fewer than tokens), so the documented allowance is 0.
      effectiveContextTokens: 32000,
      contextAllowance: { tokens: 0, source: "T1" },
      fieldTypes: [],
      listItemTypes: [],
      // The question types the canary observed; box is documented (D1) but not adopted in this version.
      questionTypes: ["noul", "choice", "score"],
      nullThreshold: { supported: null, unsupportedOn: [] },
      // The catalog's per-token prices (C1, 2026-11-12): prompt 0.000000042 USD per token, completion 0 (TypeSafe's own
      // page: USD 0.042 per million input tokens, output free). They reproduce the canary's reported cost exactly (399
      // input tokens: 0.000016758). No ceiling is documented, so a call reserves the whole per-request budget.
      pricing: { revision: "openrouter-catalog-2026-11-12", currency: "USD", perMillionInputTokens: "0.042", perMillionOutputTokens: "0", upperBound: false },
      zdr: "unknown",
      canary: {
        status: "passed",
        on: "2026-11-12",
        reports: ["decisions-20261112T215015Z.json", "decisions-20261112T225714Z.json"],
        wireRevision: "openrouter-alpha-decisions-2026-11-12.2",
      },
      notes: [
        "Named questions in the request, answers in the response; per-question refusal (D1).",
        "Enabled for noul, choice and score over text. Box answers and image input are documented but not adopted in this version.",
        "Requests are refused above 32000 bytes of state and questions: TypeSafe's default per-question limit (T1), read at its lower value.",
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
