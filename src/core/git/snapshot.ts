import { GitError, splitNul, type Git } from './exec.js'

export interface Snapshot {
  /** HEAD at the time of the snapshot; `null` on an unborn branch. */
  head: string | null
  /** Paths that were in the index before unbraid touched anything. */
  stagedPaths: string[]
}

/**
 * Record enough state to put the repository back exactly as we found it.
 *
 * This only needs to capture HEAD and the index. unbraid never modifies file
 * contents, so the working tree needs no snapshot — which is precisely what
 * makes rollback trustworthy rather than best-effort.
 */
export async function takeSnapshot(git: Git): Promise<Snapshot> {
  const headResult = await git.runRaw(['rev-parse', 'HEAD'])
  const head = headResult.code === 0 ? headResult.stdout.trim() : null

  const stagedResult = await git.runRaw([
    'diff',
    '--name-only',
    '--cached',
    '-z',
  ])
  const stagedPaths =
    stagedResult.code === 0 ? splitNul(stagedResult.stdout) : []

  return { head, stagedPaths }
}

/**
 * Undo everything unbraid did: remove any commits it created and restore the
 * original staging.
 *
 * Working tree contents are never touched, at any point, including here.
 */
export async function restoreSnapshot(
  git: Git,
  snapshot: Snapshot,
): Promise<void> {
  if (snapshot.head) {
    // --soft moves the branch pointer only; index and working tree survive.
    await git.run(['reset', '--soft', snapshot.head])
    // Then clear the index back to HEAD without touching files on disk.
    await git.runRaw(['reset', '--quiet', 'HEAD', '--', '.'])
  } else {
    // Unborn branch: there was no HEAD to return to, so delete the ref that
    // our commits created and empty the index.
    await git.runRaw(['update-ref', '-d', 'HEAD'])
    await git.runRaw(['rm', '-r', '--cached', '-q', '--', '.'])
  }

  if (snapshot.stagedPaths.length > 0) {
    await stageInBatches(git, snapshot.stagedPaths)
  }
}

/**
 * Stage paths in batches.
 *
 * A 200-file changeset can exceed the operating system's argument length limit,
 * which surfaces as a confusing E2BIG rather than a git error.
 */
export async function stageInBatches(
  git: Git,
  paths: string[],
  batchSize = 200,
): Promise<void> {
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize)
    // -A so that deletions are staged as deletions rather than skipped.
    const result = await git.runRaw(['add', '-A', '--', ...batch])
    if (result.code === 0) continue

    if (!mentionsIgnoredPath(result.stderr)) {
      throw new GitError(
        `git add -A failed (exit ${result.code}): ${result.stderr.trim()}`,
        ['add', '-A', '--', ...batch],
        result.code,
        result.stderr,
      )
    }

    // git refuses the whole batch when any path in it is ignored, so nothing
    // was staged. Retry one at a time to separate the ignored paths out.
    for (const path of batch) {
      const single = await git.runRaw(['add', '-A', '--', path])
      if (single.code === 0) continue
      if (!mentionsIgnoredPath(single.stderr)) {
        throw new GitError(
          `git add -A failed (exit ${single.code}): ${single.stderr.trim()}`,
          ['add', '-A', '--', path],
          single.code,
          single.stderr,
        )
      }
      await removeFromIndex(git, path)
    }
  }
}

function mentionsIgnoredPath(stderr: string): boolean {
  return /ignored by one of your \.gitignore files/.test(stderr)
}

/**
 * Record that a path leaves the index while staying on disk.
 *
 * This is the one change `git add` cannot express. A file removed from tracking
 * with `git rm --cached` and then covered by .gitignore is still sitting in the
 * working tree, so `add` sees an ignored file and refuses rather than seeing a
 * deletion — which is what the index already says it is. Ignoring a directory
 * that was previously committed is the ordinary way to arrive here.
 *
 * --ignore-unmatch so that a path already absent from the index is not an
 * error: the caller wants it gone, and it is.
 */
async function removeFromIndex(git: Git, path: string): Promise<void> {
  await git.run(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path])
}
