import { createGit, type Git } from '../core/git/exec.js'
import { readWorkingTree } from '../core/git/read.js'
import { preflight } from '../core/git/preflight.js'
import { collectDiffs } from '../core/git/diff.js'
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

export interface PipelineOptions {
  cwd: string
  config: Config
  force?: boolean
  onEvent?: (event: PlanEvent) => void
  /** Called after the tree is read but before any model call. */
  onTreeRead?: (state: WorkingTreeState, provider: Provider, style: RepoStyle) => void
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

  const style = await inferStyle(git, config.context.logSample)
  const provider = await resolveProvider(config)

  options.onTreeRead?.(state, provider, style)

  if (options.beforeModel && !(await options.beforeModel(state, provider))) {
    throw new PipelineError('Cancelled.')
  }

  const groupingDiffs = await collectDiffs(git, state.files, state.head, {
    truncateLines: config.context.truncateLines,
    maxBytes: config.context.maxDiffBytes,
    exclude: config.context.exclude,
  })

  const plan = await createPlan(state, config, style, {
    provider,
    groupingDiffs,
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

  return { git, state, style, provider, plan }
}
