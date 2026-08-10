import type { Git } from '../git/exec.js'
import type { MessageFormat } from '../config/schema.js'

export interface RepoStyle {
  /** Never 'auto' — this is the resolved answer. */
  format: Exclude<MessageFormat, 'auto'>
  usesScopes: boolean
  /** Conventional types actually used here, most frequent first. */
  commonTypes: string[]
  commonScopes: string[]
  averageTitleLength: number
  /** Fraction of sampled commits that had a body, 0–1. */
  bodyRate: number
  /** Real subjects from this repo, shown to the model as examples. */
  samples: string[]
}

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?: .+/
// A leading :shortcode: or an actual pictographic character.
const GITMOJI = /^(?::[a-z0-9_+-]+:|\p{Extended_Pictographic})/u

/**
 * Learn how this repository writes commit messages.
 *
 * The point is that `message.format: auto` should need no configuration to fit
 * in. Matching what a repo already does beats imposing a convention on it, and
 * is the difference between commits that look native and commits that look like
 * a tool wrote them.
 */
export async function inferStyle(
  git: Git,
  sampleSize = 20,
): Promise<RepoStyle> {
  // %s is the subject, %b the body; the record separator keeps multi-line
  // bodies from being mistaken for new commits.
  const result = await git.runRaw([
    'log',
    `-n${sampleSize}`,
    '--no-merges',
    '--format=%s%x1f%b%x1e',
  ])

  if (result.code !== 0 || result.stdout.trim() === '') {
    return emptyStyle()
  }

  const entries = result.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })

  return analyzeCommits(entries)
}

/**
 * Pure analysis, separated from git so it can be tested against hand-written
 * histories without building a repository for each case.
 */
export function analyzeCommits(
  commits: Array<{ subject: string; body: string }>,
): RepoStyle {
  const subjects = commits.map((c) => c.subject).filter(Boolean)
  if (subjects.length === 0) return emptyStyle()

  const types = new Map<string, number>()
  const scopes = new Map<string, number>()
  let conventional = 0
  let gitmoji = 0

  for (const subject of subjects) {
    if (GITMOJI.test(subject)) {
      gitmoji++
      continue
    }
    const match = CONVENTIONAL.exec(subject)
    if (match) {
      conventional++
      const type = match[1]!
      types.set(type, (types.get(type) ?? 0) + 1)
      const scope = match[2]
      if (scope) scopes.set(scope, (scopes.get(scope) ?? 0) + 1)
    }
  }

  const total = subjects.length
  // A majority, not a plurality: a couple of stray `fix:` commits in an
  // otherwise prose history should not flip the whole repo's style.
  const format: RepoStyle['format'] =
    gitmoji / total > 0.5
      ? 'gitmoji'
      : conventional / total > 0.5
        ? 'conventional'
        : 'plain'

  const byFrequency = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key)

  return {
    format,
    usesScopes: scopes.size > 0 && conventional > 0 && scopes.size / conventional > 0.3,
    commonTypes: byFrequency(types).slice(0, 8),
    commonScopes: byFrequency(scopes).slice(0, 10),
    averageTitleLength: Math.round(
      subjects.reduce((n, s) => n + s.length, 0) / total,
    ),
    bodyRate: commits.filter((c) => c.body.length > 0).length / commits.length,
    samples: subjects.slice(0, 5),
  }
}

function emptyStyle(): RepoStyle {
  return {
    format: 'conventional',
    usesScopes: false,
    commonTypes: [],
    commonScopes: [],
    averageTitleLength: 50,
    bodyRate: 0,
    samples: [],
  }
}
