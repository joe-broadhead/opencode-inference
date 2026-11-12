import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A fresh folder under TMPDIR, by its real path. */
export const tempRoot = (name: string) => realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `inference-${name}-`)))
