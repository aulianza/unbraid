/**
 * Semantic version comparison.
 *
 * Its own module with its own tests because this exact shape of code was
 * written wrong once already in this project: comparing every component
 * independently reports 11.6.0 as older than 11.5.1, because the patch number
 * is smaller. Only the first differing component decides.
 */

/** Returns negative if a < b, zero if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)

  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }

  // 1.0.0-beta precedes 1.0.0. Absent prerelease wins; otherwise compare as
  // strings, which is enough to order beta.1 before beta.2.
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

interface Parsed {
  parts: number[]
  prerelease: string
}

function parse(version: string): Parsed {
  // Drop build metadata, which never affects precedence.
  const withoutBuild = version.trim().replace(/^v/, '').split('+')[0] ?? ''
  const [core = '', ...prerelease] = withoutBuild.split('-')

  return {
    parts: core.split('.').map((part) => {
      const n = Number.parseInt(part, 10)
      return Number.isFinite(n) ? n : 0
    }),
    prerelease: prerelease.join('-'),
  }
}
