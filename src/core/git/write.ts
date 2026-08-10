import type { Git } from './exec.js'
import { stageInBatches } from './snapshot.js'
import { restoreSnapshot, takeSnapshot, type Snapshot } from './snapshot.js'
import type { CommitPlan } from '../engine/types.js'
import {
  hunkPathsFor,
  stageHunksForCommit,
  type HunkContext,
} from './hunk-stage.js'

export interface ExecuteOptions {
  /** Run the repository's git hooks. Default true — they are the user's rules. */
  verify?: boolean
  /** Called after each commit lands, for progress reporting. */
  onCommit?: (id: string, sha: string, index: number, total: number) => void
  /** Supplied only when the plan splits files by hunk. */
  hunkContext?: HunkContext
}

export interface ExecuteResult {
  /** SHAs of the commits created, in order. */
  shas: string[]
  /** Set when execution failed and the repository was rolled back. */
  rolledBack?: { reason: string }
}

/**
 * Turn a `CommitPlan` into real commits.
 *
 * The whole run is atomic in effect: if any commit fails, every commit this
 * function created is removed and the original staging is restored. Callers get
 * either all of the commits or none of them, never a half-applied plan.
 */
export async function executePlan(
  git: Git,
  plan: CommitPlan,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const { verify = true, onCommit } = options

  const snapshot = await takeSnapshot(git)
  const shas: string[] = []

  const commits = plan.commits.filter((c) => c.files.length > 0)

  try {
    for (const [index, commit] of commits.entries()) {
      // Reset the index between commits so each one contains exactly its own
      // files, regardless of what the previous iteration staged.
      await git.runRaw(['reset', '--quiet', '--', '.'])

      const hunkPaths = options.hunkContext
        ? hunkPathsFor(commit, options.hunkContext)
        : []

      // Files split by hunk are staged as computed content; the rest are staged
      // as they exist on disk.
      const wholePaths = commit.files.filter((path) => !hunkPaths.includes(path))
      await stageInBatches(git, wholePaths)

      for (const path of hunkPaths) {
        await stageHunksForCommit(git, plan, index, path, options.hunkContext!)
      }

      const sha = await createCommit(git, commit.title, commit.body, verify)
      shas.push(sha)
      onCommit?.(commit.id, sha, index + 1, commits.length)
    }
  } catch (error) {
    await restoreSnapshot(git, snapshot)
    return {
      shas: [],
      rolledBack: { reason: error instanceof Error ? error.message : String(error) },
    }
  }

  return { shas }
}

/**
 * Create one commit. Returns its SHA.
 *
 * The message is passed as two `-m` arguments; git joins them with a blank line,
 * which is exactly the title/body convention. Using argv rather than a temp file
 * means no escaping concerns and nothing to clean up.
 */
export async function createCommit(
  git: Git,
  title: string,
  body: string | null,
  verify = true,
): Promise<string> {
  const args = ['commit', '-m', title]
  if (body && body.trim().length > 0) args.push('-m', body)
  if (!verify) args.push('--no-verify')

  await git.run(args)
  return (await git.run(['rev-parse', 'HEAD'])).trim()
}

export interface PushOptions {
  remote?: string
  /** Defaults to the current branch. */
  branch?: string
  setUpstream?: boolean
}

/**
 * Push once, after all commits have landed.
 *
 * Deliberately never force-pushes: unbraid only ever adds commits on top of what
 * is already there, so a rejected push means someone else pushed first and the
 * user needs to decide what to do.
 */
export async function push(git: Git, options: PushOptions = {}): Promise<void> {
  const remote = options.remote ?? 'origin'
  const branch =
    options.branch ?? (await git.run(['symbolic-ref', '--short', 'HEAD'])).trim()

  const args = ['push']
  if (options.setUpstream) args.push('--set-upstream')
  args.push(remote, branch)

  await git.run(args)
}

export type { Snapshot }
