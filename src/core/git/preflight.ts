import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Git } from './exec.js'
import type { GitOperation } from '../engine/types.js'

export interface PreflightResult {
  ok: boolean
  operation: GitOperation
  detached: boolean
  /** Human-readable explanations for why `ok` is false. Empty when ok. */
  reasons: string[]
}

export interface PreflightOptions {
  /** Proceed despite detached HEAD. Does not override in-progress operations. */
  force?: boolean
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Decide whether it is safe to create commits in this repository.
 *
 * unbraid refuses to run mid-merge, mid-rebase, mid-cherry-pick, mid-revert, or
 * mid-bisect. In every one of those states git is holding partial work that our
 * snapshot/rollback cannot faithfully restore, and committing into them would
 * produce history the user did not ask for.
 *
 * Detached HEAD is different in kind: it is unusual rather than unsafe, so it is
 * refused by default but can be overridden with `force`. An in-progress
 * operation is never overridable.
 */
export async function preflight(
  git: Git,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const gitDirResult = await git.runRaw(['rev-parse', '--absolute-git-dir'])
  if (gitDirResult.code !== 0) {
    return {
      ok: false,
      operation: 'none',
      detached: false,
      reasons: [`Not a git repository: ${git.cwd}`],
    }
  }

  const gitDir = gitDirResult.stdout.trim()
  const reasons: string[] = []

  const operation = await detectOperation(gitDir)
  if (operation !== 'none') {
    reasons.push(
      `A ${operation} is in progress. Finish or abort it before running unbraid.`,
    )
  }

  // `symbolic-ref HEAD` fails exactly when HEAD is not pointing at a branch.
  const symbolic = await git.runRaw(['symbolic-ref', '--quiet', 'HEAD'])
  const detached = symbolic.code !== 0

  if (detached && !options.force) {
    reasons.push(
      'HEAD is detached. Commits would not belong to any branch. Re-run with --force to proceed anyway.',
    )
  }

  return { ok: reasons.length === 0, operation, detached, reasons }
}

async function detectOperation(gitDir: string): Promise<GitOperation> {
  // Order matters: a conflicted cherry-pick also leaves MERGE_HEAD behind, so
  // the more specific markers are checked first.
  const checks: Array<[GitOperation, string]> = [
    ['cherry-pick', 'CHERRY_PICK_HEAD'],
    ['revert', 'REVERT_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
    ['merge', 'MERGE_HEAD'],
    ['bisect', 'BISECT_LOG'],
  ]

  for (const [operation, marker] of checks) {
    if (await exists(join(gitDir, marker))) return operation
  }
  return 'none'
}
