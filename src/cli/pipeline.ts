import { createGit, type Git } from '../core/git/exec.js'
import { readWorkingTree } from '../core/git/read.js'
import { preflight } from '../core/git/preflight.js'
import { collectDiffs } from '../core/git/diff.js'
import { buildHunkContext, type HunkContext } from '../core/git/hunk-stage.js'
import { describeHunk } from '../core/git/hunks.js'
import { inferStyle } from '../core/engine/style.js'
import { createPlan, type PlanEvent } from '../core/engine/plan.js'
import { resolveProvider } from '../core/providers/resolve.js'
import type { Config } from '../core/config/schema.js'
import type { CommitPlan, WorkingTreeState } from '../core/engine/types.js'
import type { Provider } from '../core/providers/types.js'
import type { RepoStyle } from '../core/engine/style.js'

export interface PipelineResult {
  git: Git
  state: WorkingTreeState
  style: RepoStyle
  provider: Provider
  plan: CommitPlan
  /** Present only when hunk splitting was enabled and found something to split. */
  hunkContext?: HunkContext
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}

/**
 * The phases before the model is called.
 *
 * Each one is git work that takes long enough to notice on a large repository,
 * and until now they ran with nothing on screen: the first output appeared only
 * once the tree had been read, the style inferred, and a provider probed.
 */
export type PipelineStage =
  /** Listing what changed. */
  | 'reading'
  /** Reading recent commits and working out which provider to use. */
  | 'style'
  /** Collecting the diffs the model will be shown. */
  | 'diffing'
  /** Splitting files into hunks. */
  | 'hunks'

export interface PipelineOptions {
  cwd: string
  config: Config
  force?: boolean
  onEvent?: (event: PlanEvent) => void
  /** Called as each pre-model phase begins. */
  onStage?: (stage: PipelineStage) => void
  /** Called after the tree is read but before any model call. */
  onTreeRead?: (state: WorkingTreeState, provider: Provider, style: RepoStyle) => void
  /** Called around the credential prompt so progress UI can be suspended. */
  onPromptOpen?: () => void
  /** Return false to abort before contacting the provider. */
  beforeModel?: (state: WorkingTreeState, provider: Provider) => Promise<boolean>
}

/**
 * The shared read → analyse → plan path used by every command that needs a plan.
 *
 * Kept separate from argument parsing so `unbraid`, `unbraid plan --json`, and
 * any future front end all produce plans through exactly one code path.
 */
export async function buildPlan(
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { cwd, config } = options
  const git = createGit(cwd)

  options.onStage?.('reading')
  const check = await preflight(git, { force: options.force })
  if (!check.ok) {
    throw new PipelineError(check.reasons.join('\n'))
  }

  const state = await readWorkingTree(git, {
    expandUntrackedDirsUpTo: config.grouping.expandUntrackedDirsUpTo,
  })

  if (state.files.length === 0) {
    throw new PipelineError(
      'Nothing to commit — the working tree is clean.',
      'Make some changes first.',
    )
  }

  options.onStage?.('style')
  const style = await inferStyle(git, config.context.logSample)
  const provider = await resolveProvider(config)

  options.onTreeRead?.(state, provider, style)

  if (options.beforeModel) {
    options.onPromptOpen?.()
  }
  if (options.beforeModel && !(await options.beforeModel(state, provider))) {
    throw new PipelineError('Cancelled.')
  }

  options.onStage?.('diffing')
  const groupingDiffs = await collectDiffs(git, state.files, state.head, {
    truncateLines: config.context.truncateLines,
    maxBytes: config.context.maxDiffBytes,
    exclude: config.context.exclude,
  })

  // Only text files that are modified in place can be split; a new, deleted, or
  // collapsed entry has no meaningful "before" to diff hunks against.
  let hunkContext: HunkContext | undefined
  let splittable: Map<string, Array<{ id: string; description: string }>> | undefined

  if (config.grouping.hunks) {
    const candidates = state.files
      .filter((file) => file.status === 'modified' && !file.binary && !file.collapsed)
      .map((file) => file.path)

    if (candidates.length > 0) {
      options.onStage?.('hunks')
      hunkContext = await buildHunkContext(git, candidates, state.head)
      if (hunkContext.hunksByPath.size > 0) {
        splittable = new Map(
          [...hunkContext.hunksByPath].map(([path, hunks]) => [
            path,
            hunks.map((hunk) => ({ id: hunk.id, description: describeHunk(hunk) })),
          ]),
        )
      } else {
        hunkContext = undefined
      }
    }
  }

  const plan = await createPlan(state, config, style, {
    provider,
    groupingDiffs,
    ...(splittable ? { splittable } : {}),
    getFullDiffs: async (paths) => {
      const wanted = new Set(paths)
      return collectDiffs(
        git,
        state.files.filter((file) => wanted.has(file.path)),
        state.head,
        {
          maxBytes: config.context.maxDiffBytes,
          exclude: config.context.exclude,
        },
      )
    },
    onEvent: options.onEvent,
  })

  return { git, state, style, provider, plan, ...(hunkContext ? { hunkContext } : {}) }
}
