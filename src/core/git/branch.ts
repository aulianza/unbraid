import type { Git } from './exec.js'

export interface BranchCommit {
  sha: string
  subject: string
  body: string
}

export interface BranchSummary {
  branch: string
  base: string
  /** Commits on this branch that are not on the base, oldest first. */
  commits: BranchCommit[]
  filesChanged: number
  insertions: number
  deletions: number
  /** `git diff --stat` against the merge base. */
  diffstat: string
}

export class BranchError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'BranchError'
  }
}

const COMMON_BASES = ['main', 'master', 'develop', 'trunk']

/**
 * Work out which branch this one would be merged into.
 *
 * `origin/HEAD` is the authoritative answer when the remote publishes it, which
 * is why it is tried first — hardcoding `main` is wrong for every repository
 * that predates the rename, and hardcoding `master` is wrong for every one that
 * does not.
 */
export async function resolveBaseBranch(
  git: Git,
  explicit?: string,
): Promise<string> {
  if (explicit) {
    if (!(await refExists(git, explicit))) {
      throw new BranchError(`Base branch "${explicit}" does not exist.`)
    }
    return explicit
  }

  const remoteHead = await git.runRaw([
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (remoteHead.code === 0) {
    const ref = remoteHead.stdout.trim()
    if (ref && (await refExists(git, ref))) return ref
  }

  for (const name of COMMON_BASES) {
    for (const candidate of [`origin/${name}`, name]) {
      if (await refExists(git, candidate)) return candidate
    }
  }

  throw new BranchError(
    'Could not work out which branch to compare against.',
    'Pass one explicitly, for example: unbraid pr --base main',
  )
}

async function refExists(git: Git, ref: string): Promise<boolean> {
  const result = await git.runRaw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.code === 0
}

/**
 * Everything needed to describe a branch as a pull request.
 *
 * Comparisons use the merge base rather than the base branch tip, so commits
 * landed on the base since this branch started do not appear as this branch's
 * work.
 */
export async function summarizeBranch(
  git: Git,
  base: string,
): Promise<BranchSummary> {
  const branchResult = await git.runRaw(['symbolic-ref', '--short', '--quiet', 'HEAD'])
  if (branchResult.code !== 0) {
    throw new BranchError(
      'HEAD is detached, so there is no branch to describe.',
      'Check out a branch first.',
    )
  }
  const branch = branchResult.stdout.trim()

  const mergeBaseResult = await git.runRaw(['merge-base', base, 'HEAD'])
  if (mergeBaseResult.code !== 0) {
    throw new BranchError(
      `"${base}" and "${branch}" share no common history.`,
      'Pass a different base with --base.',
    )
  }
  const mergeBase = mergeBaseResult.stdout.trim()

  const commits = await readCommits(git, mergeBase)
  if (commits.length === 0) {
    throw new BranchError(
      `"${branch}" has no commits that "${base}" does not already have.`,
      'Commit something first, or pass a different base with --base.',
    )
  }

  const numstat = await git.runRaw(['diff', '--numstat', `${mergeBase}..HEAD`])
  let filesChanged = 0
  let insertions = 0
  let deletions = 0

  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue
    const [ins = '', del = ''] = line.split('\t')
    filesChanged++
    if (ins !== '-') insertions += Number(ins) || 0
    if (del !== '-') deletions += Number(del) || 0
  }

  const diffstat = (
    await git.runRaw(['diff', '--stat', '--stat-width=80', `${mergeBase}..HEAD`])
  ).stdout.trim()

  return { branch, base, commits, filesChanged, insertions, deletions, diffstat }
}

async function readCommits(git: Git, from: string): Promise<BranchCommit[]> {
  const result = await git.runRaw([
    'log',
    '--reverse',
    '--no-merges',
    '--format=%H%x1f%s%x1f%b%x1e',
    `${from}..HEAD`,
  ])
  if (result.code !== 0) return []

  return result.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f')
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() }
    })
}

/** Lift a ticket key such as `PROJ-123` out of a branch name. */
export function extractTicket(
  branch: string,
  pattern: string | null,
): string | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern).exec(branch)?.[1] ?? null
  } catch {
    return null
  }
}
