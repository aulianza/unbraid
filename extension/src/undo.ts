import type { Git } from 'unbraid'

/**
 * Everything needed to unwind a run.
 *
 * Recorded before the commits are made, because afterwards the information is
 * gone: `git reset` needs to know where HEAD was, and restoring the user's
 * staging needs to know what they had staged.
 */
export interface UndoRecord {
  cwd: string
  /** HEAD before the run. Null when the branch had no commits yet. */
  beforeHead: string | null
  /** HEAD after the run. Used to check nothing else has happened since. */
  afterHead: string
  /** What the user had staged before unbraid touched the index. */
  stagedPaths: string[]
  commits: number
}

export type UndoCheck =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Whether the recorded run can still be undone.
 *
 * The check that matters is whether HEAD is still where the run left it. If the
 * user has committed, merged, rebased, or pulled since, a reset would throw away
 * work unbraid never created — which is the one thing this feature must never
 * do. Refusing is always the right answer when unsure.
 */
export function canUndo(record: UndoRecord | null, currentHead: string | null): UndoCheck {
  if (!record) return { ok: false, reason: 'There is no unbraid run to undo.' }
  if (currentHead === null) {
    return { ok: false, reason: 'The branch has no commits.' }
  }
  if (currentHead !== record.afterHead) {
    return {
      ok: false,
      reason:
        'The branch has moved since that run, so undoing it would discard work unbraid did not create.',
    }
  }
  return { ok: true }
}

export function describeUndo(record: UndoRecord): string {
  const commits = `${record.commits} commit${record.commits === 1 ? '' : 's'}`
  const staging =
    record.stagedPaths.length > 0
      ? ` and restore the ${record.stagedPaths.length} file${record.stagedPaths.length === 1 ? '' : 's'} you had staged`
      : ''
  return `This will undo ${commits}${staging}. Your files are not touched — the changes go back to being uncommitted.`
}

/**
 * Unwind the run.
 *
 * `--soft` so the changes return to the index rather than being destroyed, then
 * the index is reset and the user's original staging is put back. At no point is
 * anything written to the working tree, which is why this is safe to offer as a
 * one-click action.
 */
export async function performUndo(git: Git, record: UndoRecord): Promise<void> {
  if (record.beforeHead) {
    await git.run(['reset', '--soft', record.beforeHead])
  } else {
    // The run created the first commits on an unborn branch; there is no
    // earlier commit to return to.
    await git.runRaw(['update-ref', '-d', 'HEAD'])
  }

  // Clear the index, then put back exactly what the user had staged.
  await git.runRaw(['reset', '--quiet', '--', '.'])
  if (record.stagedPaths.length > 0) {
    for (let i = 0; i < record.stagedPaths.length; i += 200) {
      await git.run(['add', '-A', '--', ...record.stagedPaths.slice(i, i + 200)])
    }
  }
}

/** Read what is needed to undo a run, before the run happens. */
export async function captureBefore(
  git: Git,
  cwd: string,
): Promise<Omit<UndoRecord, 'afterHead' | 'commits'>> {
  const headResult = await git.runRaw(['rev-parse', 'HEAD'])
  const stagedResult = await git.runRaw(['diff', '--name-only', '--cached', '-z'])

  return {
    cwd,
    beforeHead: headResult.code === 0 ? headResult.stdout.trim() : null,
    stagedPaths:
      stagedResult.code === 0
        ? stagedResult.stdout.split('\0').filter((path) => path.length > 0)
        : [],
  }
}
