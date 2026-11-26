import { readFileSync } from "node:fs"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"

/** The installed package, as the kit reads it: package.json, with its version and capabilities. */
export function packageOf(): { version: string; capabilities: Manifest } {
  return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string; capabilities: Manifest }
}

/** The plugin's manifest. */
export const manifestOf = (): Manifest => packageOf().capabilities
