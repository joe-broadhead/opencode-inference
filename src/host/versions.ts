// Host versions, with no imports, so the TUI bundle can use them without zod.

/** The supported OpenCode line. package.json `opencode.host` states the same range. */
export const HOST_RANGE = ">=2.2.3 <2.3.0"
/** The releases every host, pack and stock test runs on. The one list: the tests, CI and the release read it. */
export const TESTED_HOSTS = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"] as const
export const TESTED_TEXT = "OpenCode 2.2.3, 2.2.4, 2.2.5 or 2.2.6"

type Version = readonly [number, number, number]
const parse = (value: string): Version | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Whether `version` is a release inside `>=low <high`. Prereleases, dev builds and "unknown" are outside. */
export function inRange(version: string, range = HOST_RANGE) {
  const [, low, high] = /^>=(\S+) <(\S+)$/.exec(range) ?? []
  const found = parse(version)
  const min = low && parse(low)
  const max = high && parse(high)
  if (!found || !min || !max) return false
  return compare(found, min) >= 0 && compare(found, max) < 0
}
export const tested = (version: string) => (TESTED_HOSTS as readonly string[]).includes(version)

/** The status view's shared `host` fields, plus a next step when the host is outside the range. */
export interface HostCheck {
  readonly version: string | null
  readonly range: string
  readonly tested: boolean
  readonly next?: string
}

/** The OpenCode row's text. */
export const hostText = (host: HostCheck) =>
  host.tested ? `${host.version} (tested)`
  : host.version !== null && inRange(host.version, host.range) ? `${host.version} (untested; supported range ${host.range})`
  : `${host.version ?? "unknown"} (outside ${host.range}; allowUntestedHost is set)`
