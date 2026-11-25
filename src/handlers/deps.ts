import type { AccountProfile, AccountSignal } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { ConnectionHost } from "../accounts.js"
import type { Config } from "../domain/config.js"
import type { CapabilityFixture } from "../provider/capabilities.js"
import type { OperationRuntime } from "../runtime/operation.js"

/** What every handler factory needs: the installed manifest, the trusted options and the operation runtime. */
export interface HandlerDeps {
  readonly manifest: Manifest
  readonly version: string
  /** The OpenCode release the plugin runs on, from ctx.app.version. */
  readonly hostVersion: string
  readonly config: Config
  readonly fixture: CapabilityFixture
  /** Every alias the options declare, in their order. */
  readonly profiles: readonly AccountProfile[]
  /** What registering the accounts could not do; status reports each. */
  readonly accountProblems: readonly string[]
  readonly integration: ConnectionHost
  readonly operation: OperationRuntime
  readonly now?: (() => Date) | undefined
}

/** The state of every alias, for status. */
export type Signals = () => Promise<Readonly<Record<string, AccountSignal>>>
