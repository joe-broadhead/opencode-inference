import type { Config } from "../domain/config.js"
import { MODULES, type ConnectionState, type Rule, type StatusView } from "../domain/ids.js"
import { PLANNED, TOOL_NAMES, actionOf } from "../domain/registry.js"
import { implemented } from "../domain/registry.js"
import { completeStatus } from "../rpc.js"
import { fixtureAgeDays, STALE_AFTER_DAYS, type CapabilityFixture } from "../providers/openrouter/capabilities.js"
import type { HostCheck } from "./versions.js"
import { defaultRules, unguardedAgents } from "./permissions.js"

export interface StatusSources {
  readonly version: string
  readonly host: HostCheck
  readonly config: Config
  readonly fixture: CapabilityFixture
  readonly connection: () => Promise<{ state: ConnectionState; next?: string }>
  /** Read lazily: OpenCode creates config-only agents after plugins set up. */
  readonly agents: () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]>
  readonly problems: () => readonly string[]
  readonly now?: () => Date
}

/** True when some enabled route of an implemented operation, with its module on, would send with the key. */
export function keyRequired(config: Config, fixture: CapabilityFixture) {
  return fixture.routes.some((route) => route.enabled && implemented(route.operation) && config.modules[PLANNED.find((operation) => operation.name === route.operation)!.module])
}

/** Joins the plugin's facts with the host's. No provider is called and no key is read. */
export async function buildStatus(sources: StatusSources): Promise<StatusView> {
  const { config, fixture } = sources
  const [connection, agents] = await Promise.all([sources.connection(), sources.agents().catch(() => [])])
  const ageDays = fixtureAgeDays(fixture, (sources.now ?? (() => new Date()))())
  const view = completeStatus({
    version: sources.version,
    host: sources.host,
    unguardedAgents: unguardedAgents(agents, config.access),
    connection: { integration: "inference-openrouter", state: connection.state, required: keyRequired(config, fixture), ...(connection.next ? { next: connection.next } : {}) },
    access: config.access,
    modules: Object.fromEntries(MODULES.map((name) => [name, { enabled: config.modules[name] }])) as StatusView["modules"],
    tools: { registered: TOOL_NAMES.map(actionOf), planned: PLANNED.map((operation) => operation.tool) },
    capabilities: {
      revision: fixture.revision,
      reviewedOn: fixture.reviewedOn,
      ageDays,
      stale: ageDays > STALE_AFTER_DAYS,
      basis: fixture.basis,
      routes: fixture.routes.length,
      enabledRoutes: fixture.routes.filter((route) => route.enabled).length,
    },
    spend: { currency: "USD", requestUsd: config.spend.requestUsd, sessionUsd: config.spend.sessionUsd, rolling24hUsd: config.spend.rolling24hUsd, tracking: "none" },
    operations: { tracking: "none" },
    permissions: { block: defaultRules(config.access) },
    problems: [...sources.problems()].slice(0, 8),
  })
  return JSON.parse(JSON.stringify(view)) as StatusView
}
