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
  /**
   * Subjects of merge commits on this branch.
   *
   * Their contents are in the diff but are not this branch's work, so the
   * description should acknowledge them rather than describe them.
   */
  merges: string[]
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
      // Listing what does exist turns "wrong branch name" from a dead end into
      // a one-character fix.
      const available = await listBranches(git)
      throw new BranchError(
        `Branch "${explicit}" does not exist.`,
        available.length > 0 ? `Available: ${available.join(', ')}` : undefined,
      )
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

/** The names of the configured remotes, e.g. ['origin', 'upstream']. */
export async function remoteNames(git: Git): Promise<string[]> {
  const result = await git.runRaw(['remote'])
  if (result.code !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Turn a remote-tracking ref into the branch name the host knows it by.
 *
 * Base detection deliberately resolves to `origin/master`: that is the ref
 * worth diffing against, since a local `master` is often days stale. GitHub has
 * no branch by that name, though — a compare URL or a `gh --base` built from it
 * points at nothing. The two uses need different strings, so the ref stays as
 * it is for comparing and passes through here for anything the host will read.
 */
export function stripRemotePrefix(ref: string, remotes: string[]): string {
  for (const remote of remotes) {
    const prefix = `${remote}/`
    if (ref.startsWith(prefix)) return ref.slice(prefix.length)
  }
  return ref
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
/**
 * The branch HEAD points at, or null when HEAD is detached.
 *
 * Null rather than a throw: callers that only want to know whether there is a
 * branch to work with should not have to catch to find out.
 */
export async function currentBranch(git: Git): Promise<string | null> {
  const result = await git.runRaw(['symbolic-ref', '--short', '--quiet', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() : null
}

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
  const merges = await readMerges(git, mergeBase)
  if (commits.length === 0) {
    throw new BranchError(
      `"${branch}" has no commits that "${base}" does not already have.`,
      'Commit something first, or pass a different base with --base.',
    )
  }

  /**
   * Counted over this branch's own commits, not over the diff to the base.
   *
   * `git diff base...HEAD` includes anything merged in along the way. Merge
   * `dev` into a feature branch and the pull request claims dev's work as its
   * own: "60 files · +2624/-69" for a branch that touched twelve. The commit
   * list already walks `--first-parent`, so the numbers now come from the same
   * walk, with merge commits themselves left out.
   *
   * The consequence is that a line edited by two commits counts twice, where a
   * diff would net them out. That is the honest reading of "what these commits
   * changed", and it beats attributing someone else's branch to this one.
   */
  const perCommit = await git.runRaw([
    'log',
    '--first-parent',
    '--no-merges',
    '--numstat',
    '--format=',
    `${mergeBase}..HEAD`,
  ])

  const touched = new Map<string, { insertions: number; deletions: number }>()
  let insertions = 0
  let deletions = 0

  for (const line of perCommit.stdout.split('\n')) {
    if (!line.trim()) continue
    const [ins = '', del = '', path = ''] = line.split('\t')
    if (path === '') continue

    const entry = touched.get(path) ?? { insertions: 0, deletions: 0 }
    // A dash means binary, which has no line count to add.
    if (ins !== '-') entry.insertions += Number(ins) || 0
    if (del !== '-') entry.deletions += Number(del) || 0
    touched.set(path, entry)

    if (ins !== '-') insertions += Number(ins) || 0
    if (del !== '-') deletions += Number(del) || 0
  }

  const filesChanged = touched.size

  // Built from the same walk rather than asking git for a second stat, so the
  // list the model reads can never disagree with the totals beside it.
  const diffstat = [...touched.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, counts]) => ` ${path} | +${counts.insertions} -${counts.deletions}`)
    .join('\n')

  return {
    branch,
    base,
    commits,
    filesChanged,
    insertions,
    deletions,
    diffstat,
    merges,
  }
}

/**
 * Commits made on this branch, excluding those absorbed from other branches.
 *
 * `--first-parent` is what makes that distinction. Without it, merging another
 * branch in drags every one of its commits into this list, and the description
 * ends up summarising somebody else's work: a branch with two commits of its own
 * reads as sixty-four.
 *
 * Those commits are still in the diff, and the file counts still reflect them.
 * They are simply not what this branch did.
 */
async function readCommits(git: Git, from: string): Promise<BranchCommit[]> {
  const result = await git.runRaw([
    'log',
    '--reverse',
    '--first-parent',
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

/** Merge commits on this branch, so the description can acknowledge them. */
async function readMerges(git: Git, from: string): Promise<string[]> {
  const result = await git.runRaw([
    'log',
    '--merges',
    '--first-parent',
    '--format=%s',
    `${from}..HEAD`,
  ])
  if (result.code !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

export interface UpstreamStatus {
  /** The tracking branch, e.g. `origin/feat/x`, or null if there is none. */
  upstream: string | null
  /** Local commits the remote does not have. */
  ahead: number
  /** Remote commits the local branch does not have. */
  behind: number
}

/**
 * How this branch stands relative to its remote.
 *
 * Two cases block opening a pull request, and the second is the dangerous one:
 * with no upstream the host cannot see the branch at all and fails loudly, but
 * an upstream that is merely behind produces a pull request missing the user's
 * latest commits — which looks like success.
 */
export async function upstreamStatus(git: Git): Promise<UpstreamStatus> {
  const upstreamResult = await git.runRaw([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ])
  if (upstreamResult.code !== 0) return { upstream: null, ahead: 0, behind: 0 }

  const upstream = upstreamResult.stdout.trim()
  const counts = await git.runRaw([
    'rev-list',
    '--left-right',
    '--count',
    `${upstream}...HEAD`,
  ])
  if (counts.code !== 0) return { upstream, ahead: 0, behind: 0 }

  // `--left-right --count` prints "<behind>\t<ahead>" for upstream...HEAD.
  const [behind = '0', ahead = '0'] = counts.stdout.trim().split(/\s+/)
  return { upstream, ahead: Number(ahead) || 0, behind: Number(behind) || 0 }
}

/**
 * What `git push <remote> <branch>` will actually do.
 *
 * The tracking ref is not the answer to that question, and treating it as one
 * produced the worst message this tool has printed: a branch configured to
 * track `origin/dev` was told its sixteen commits were being pushed "to
 * origin/dev". They were not — a push names the branch, so they were only ever
 * going to `origin/games/word-scramble` — but nobody should have to know that
 * to trust the line on their screen.
 *
 * A branch can track anything. Created from `dev` with `--track`, or pointed
 * somewhere by hand, it keeps that upstream while pushing to its own name. So
 * everything here is derived from the ref the push writes to, and the tracking
 * ref appears only to be flagged when it disagrees.
 */
export interface PushPlan {
  /** Where the push writes, e.g. `origin/games/word-scramble`. */
  ref: string
  /** Whether that branch is already on the remote. */
  exists: boolean
  /** Commits HEAD has that the remote branch does not. Zero when it is new. */
  ahead: number
  /** The tracking ref, when it names something other than `ref`. */
  trackingElsewhere: string | null
}

export async function planPush(
  git: Git,
  remote: string,
  branch: string,
): Promise<PushPlan> {
  const ref = `${remote}/${branch}`

  const remoteRef = await git.runRaw([
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/${ref}`,
  ])
  const exists = remoteRef.code === 0

  let ahead = 0
  if (exists) {
    const counted = await git.runRaw(['rev-list', '--count', `${ref}..HEAD`])
    if (counted.code === 0) ahead = Number(counted.stdout.trim()) || 0
  }

  const upstream = await git.runRaw([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ])
  const tracking = upstream.code === 0 ? upstream.stdout.trim() : null

  return {
    ref,
    exists,
    ahead,
    trackingElsewhere: tracking !== null && tracking !== ref ? tracking : null,
  }
}

/** Push the current branch, setting upstream when it has none. */
export async function pushBranch(
  git: Git,
  remote: string,
  branch: string,
  setUpstream: boolean,
): Promise<void> {
  const args = ['push']
  if (setUpstream) args.push('--set-upstream')
  args.push(remote, branch)
  await git.run(args)
}

/** Branch names that exist, for suggesting alternatives to a bad `--target`. */
export async function listBranches(git: Git): Promise<string[]> {
  const result = await git.runRaw([
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
  ])
  if (result.code !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
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
