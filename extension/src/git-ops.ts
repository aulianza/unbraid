import { createGit, type Git } from 'unbraid'

/**
 * Source-control operations the panel needs beyond what unbraid's core does.
 *
 * These live in the extension rather than the library on purpose: unbraid's core
 * is deliberately narrow — it reads a tree, plans commits, and writes them — and
 * staging, discarding, and syncing are editor concerns, not part of that job.
 */

export interface BranchInfo {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
}

export function gitFor(cwd: string): Git {
  return createGit(cwd)
}

export async function stage(git: Git, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // -A so a deletion is staged as a deletion rather than skipped.
  await inBatches(paths, (batch) => git.run(['add', '-A', '--', ...batch]))
}

export async function unstage(git: Git, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await inBatches(paths, (batch) => git.run(['restore', '--staged', '--', ...batch]))
}

/**
 * Throw away changes to a path.
 *
 * The only destructive operation in this file, and the one place unbraid's usual
 * promise does not hold — so the caller must confirm before calling it. An
 * untracked file has no committed state to restore, so it is deleted instead;
 * `git restore` silently does nothing for those, which would look like a
 * no-op bug.
 */
export async function discard(
  git: Git,
  paths: string[],
  untracked: string[],
): Promise<void> {
  const tracked = paths.filter((path) => !untracked.includes(path))
  const toRemove = paths.filter((path) => untracked.includes(path))

  if (tracked.length > 0) {
    await inBatches(tracked, (batch) =>
      git.run(['restore', '--staged', '--worktree', '--', ...batch]),
    )
  }
  if (toRemove.length > 0) {
    await inBatches(toRemove, (batch) => git.run(['clean', '-fd', '--', ...batch]))
  }
}

export async function branchInfo(git: Git): Promise<BranchInfo> {
  const branchResult = await git.runRaw(['symbolic-ref', '--short', '--quiet', 'HEAD'])
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null

  const upstreamResult = await git.runRaw([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ])
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null

  if (!upstream) {
    return { branch, upstream: null, ahead: 0, behind: 0, detached: branch === null }
  }

  const counts = await git.runRaw([
    'rev-list',
    '--left-right',
    '--count',
    `${upstream}...HEAD`,
  ])
  // `--left-right --count` prints "<behind>\t<ahead>" for upstream...HEAD.
  const [behind = '0', ahead = '0'] = counts.stdout.trim().split(/\s+/)

  return {
    branch,
    upstream,
    ahead: Number(ahead) || 0,
    behind: Number(behind) || 0,
    detached: branch === null,
  }
}

export async function pull(git: Git): Promise<void> {
  // --ff-only rather than a merge: an unexpected merge commit created by a
  // button press is a surprise nobody wants in their history.
  await git.run(['pull', '--ff-only'])
}

export async function pushCurrent(git: Git, remote = 'origin'): Promise<void> {
  const info = await branchInfo(git)
  if (!info.branch) throw new Error('HEAD is detached, so there is nothing to push.')

  const args = ['push']
  if (!info.upstream) args.push('--set-upstream')
  args.push(remote, info.branch)
  await git.run(args)
}

/** Human summary of how the branch stands against its remote. */
export function describeSync(info: BranchInfo): string {
  if (info.detached) return 'detached HEAD'
  if (!info.upstream) return 'not published'
  if (info.ahead === 0 && info.behind === 0) return 'up to date'

  const parts: string[] = []
  if (info.ahead > 0) parts.push(`${info.ahead} to push`)
  if (info.behind > 0) parts.push(`${info.behind} to pull`)
  return parts.join(', ')
}

/**
 * Run in batches so a large changeset does not exceed the operating system's
 * argument limit, which surfaces as a confusing E2BIG rather than a git error.
 */
async function inBatches(
  paths: string[],
  run: (batch: string[]) => Promise<unknown>,
  size = 200,
): Promise<void> {
  for (let i = 0; i < paths.length; i += size) {
    await run(paths.slice(i, i + size))
  }
}
