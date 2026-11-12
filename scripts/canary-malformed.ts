// The canaries' malformed requests. Each breaks a rule the API reference states in its own OpenAPI schema, so OpenRouter
// must refuse it with a 4xx before any model runs; the canary passes when it does. Not a provider-specific limit the API
// may let through: a one-option choice question was accepted, answered and billed on 2026-11-12, because D1 sets no
// minimum on a choice's criteria. Pure, no network, no key; the adapter itself can never build either body.

/** The API references the rules come from. */
export const SOURCES = {
  extractions: "https://openrouter.ai/docs/api/api-reference/alphaextractions/submit-an-extractions-request",
  decisions: "https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request",
} as const

export type Endpoint = keyof typeof SOURCES

/** What each malformed request breaks, as the report states it. */
export const BREAKS: Readonly<Record<Endpoint, string>> = {
  extractions: "a list field without `items`, which ExtractionListField requires (A4)",
  decisions: "a choice question without `criteria`, which DecisionsChoiceQuestion requires (D1)",
}

/** The malformed request body for an endpoint: otherwise a valid request for `model` on `state`. */
export function malformedBody(endpoint: Endpoint, model: string, state: string): Record<string, unknown> {
  return endpoint === "extractions"
    ? { model, state, fields: { names: { type: "list", instructions: "The names in the text" } }, provider: { allow_fallbacks: false } }
    : { model, state, questions: { kind: { type: "choice", instructions: "Which document is this?" } }, provider: { allow_fallbacks: false } }
}

/** The malformed request, ready for the transport. */
export function malformedRequest(endpoint: Endpoint, model: string, state: string) {
  return { path: endpoint === "extractions" ? "/api/alpha/extractions" : "/api/alpha/decisions", body: new TextEncoder().encode(JSON.stringify(malformedBody(endpoint, model, state))) }
}
