import type { Config } from '../config/schema.js'
import type { Provider } from '../providers/types.js'
import type { FileDiff } from '../git/diff.js'
import type { CommitPlan, FileChange, RawGroup, WorkingTreeState } from './types.js'
import type { RepoStyle } from './style.js'
import { reconcile } from './reconcile.js'
import {
  GROUPING_SCHEMA,
  MESSAGE_SCHEMA,
  SINGLE_PASS_SCHEMA,
  buildGroupingPrompt,
  buildMessagePrompt,
  buildSinglePassPrompt,
  buildSystemPrompt,
} from './prompts.js'

export type PlanEvent =
  | { type: 'grouping-start'; files: number; singlePass: boolean }
  | { type: 'grouping-done'; groups: number }
  | { type: 'message-start'; group: string }
  | { type: 'message-done'; group: string }
  | { type: 'degraded'; reason: string }

export interface PlanDeps {
  provider: Provider
  /** Truncated diffs used for the grouping pass. */
  groupingDiffs: FileDiff[]
  /**
   * Files that may be split, and the hunks available in each. Supplied only
   * when hunk splitting is enabled and the file passed the round-trip check.
   */
  splittable?: Map<string, Array<{ id: string; description: string }>>
  /** Full diffs for a specific set of paths, fetched lazily for pass 2. */
  getFullDiffs: (paths: string[]) => Promise<FileDiff[]>
  onEvent?: (event: PlanEvent) => void
}

interface GroupingResponse {
  groups: Array<{
    title: string
    files: string[]
    warnings?: string[]
    hunks?: string[]
  }>
}
interface SinglePassResponse {
  groups: Array<{
    title: string
    body: string
    files: string[]
    warnings?: string[]
    hunks?: string[]
  }>
}
interface MessageResponse {
  title: string
  body: string
}

/**
 * Turn a working tree into a reviewed-ready `CommitPlan`.
 *
 * Two passes, because a hundred full diffs do not fit in any context window:
 * a cheap grouping pass over truncated diffs decides what belongs together, then
 * one message pass per group sees that group's complete diff. Small changesets
 * skip straight to a single pass, which is both cheaper and better.
 *
 * The model's output is never trusted directly — everything goes through
 * `reconcile` before it becomes a plan.
 */
export async function createPlan(
  state: WorkingTreeState,
  config: Config,
  style: RepoStyle,
  deps: PlanDeps,
): Promise<CommitPlan> {
  const system = buildSystemPrompt(config, style)
  const allPaths = state.files.map((file) => file.path)
  const availableHunks = [...(deps.splittable?.values() ?? [])]
    .flat()
    .map((hunk) => hunk.id)

  const { locked, hinted, candidates } = partition(state.files, config)
  const candidatePaths = candidates.map((file) => file.path)

  // Nothing for the model to do.
  if (candidates.length === 0) {
    return reconcile({ groups: hinted, realFiles: allPaths, locked, availableHunks })
  }

  const candidateDiffs = deps.groupingDiffs.filter((diff) =>
    candidatePaths.includes(diff.path),
  )

  try {
    if (candidates.length <= config.context.singlePassThreshold) {
      const groups = await singlePass(system, candidates, candidateDiffs, config, deps)
      return capCommits(
        reconcile({
          groups: [...hinted, ...groups],
          realFiles: allPaths,
          locked,
          availableHunks,
        }),
        config,
      )
    }

    const groups = await twoPass(system, candidates, candidateDiffs, config, deps)
    return capCommits(
      reconcile({
        groups: [...hinted, ...groups],
        realFiles: allPaths,
        locked,
        availableHunks,
      }),
      config,
    )
  } catch (error) {
    // Degrade rather than die: a single sensible commit beats a stack trace
    // after the user has already waited for a model round trip.
    const reason = error instanceof Error ? error.message : String(error)
    deps.onEvent?.({ type: 'degraded', reason })

    return reconcile({
      groups: [
        ...hinted,
        {
          title: 'chore: update project files',
          body: `unbraid could not group these automatically: ${reason}`,
          files: candidatePaths,
          warnings: ['Grouping failed; review before committing.'],
        },
      ],
      realFiles: allPaths,
      locked,
    })
  }
}

/** One call producing groups and their messages together. */
async function singlePass(
  system: string,
  files: FileChange[],
  diffs: FileDiff[],
  config: Config,
  deps: PlanDeps,
): Promise<RawGroup[]> {
  deps.onEvent?.({ type: 'grouping-start', files: files.length, singlePass: true })

  const response = await deps.provider.complete<SinglePassResponse>({
    system,
    prompt: buildSinglePassPrompt(files, diffs, config, deps.splittable),
    schema: SINGLE_PASS_SCHEMA,
    schemaName: 'commit_plan',
  })

  deps.onEvent?.({ type: 'grouping-done', groups: response.groups?.length ?? 0 })

  return (response.groups ?? []).map((group) => ({
    title: group.title,
    body: group.body?.trim() ? group.body : null,
    files: group.files ?? [],
    hunks: group.hunks ?? [],
    warnings: group.warnings ?? [],
  }))
}

/** Grouping pass, then one message pass per group, concurrently. */
async function twoPass(
  system: string,
  files: FileChange[],
  diffs: FileDiff[],
  config: Config,
  deps: PlanDeps,
): Promise<RawGroup[]> {
  deps.onEvent?.({ type: 'grouping-start', files: files.length, singlePass: false })

  const grouping = await deps.provider.complete<GroupingResponse>({
    system,
    prompt: buildGroupingPrompt(files, diffs, config, deps.splittable),
    schema: GROUPING_SCHEMA,
    schemaName: 'grouping',
  })

  const groups = (grouping.groups ?? []).filter(
    (group) => (group.files?.length ?? 0) > 0,
  )
  deps.onEvent?.({ type: 'grouping-done', groups: groups.length })

  // Concurrent: this is what hides the per-call latency of the CLI provider.
  return Promise.all(
    groups.map(async (group): Promise<RawGroup> => {
      deps.onEvent?.({ type: 'message-start', group: group.title })

      try {
        const fullDiffs = await deps.getFullDiffs(group.files)
        const message = await deps.provider.complete<MessageResponse>({
          system,
          prompt: buildMessagePrompt(group.title, group.files, fullDiffs),
          schema: MESSAGE_SCHEMA,
          schemaName: 'commit_message',
        })

        deps.onEvent?.({ type: 'message-done', group: group.title })

        return {
          title: message.title || group.title,
          body: message.body?.trim() ? message.body : null,
          files: group.files,
          hunks: group.hunks ?? [],
          warnings: group.warnings ?? [],
        }
      } catch {
        // One failed message must not discard a good grouping. Fall back to the
        // pass-1 subject, which is already a reasonable commit title.
        deps.onEvent?.({ type: 'message-done', group: group.title })
        return {
          title: group.title,
          body: null,
          files: group.files,
          hunks: group.hunks ?? [],
          warnings: [...(group.warnings ?? []), 'Message generation failed; using the provisional subject.'],
        }
      }
    }),
  )
}

/**
 * Split files into: already staged (locked), matched by a user hint, and
 * everything else (which is what the model actually sees).
 */
function partition(
  files: FileChange[],
  config: Config,
): { locked: RawGroup[]; hinted: RawGroup[]; candidates: FileChange[] } {
  const locked: RawGroup[] = []
  const remaining: FileChange[] = []

  if (config.grouping.respectStaged) {
    const staged = files.filter((file) => file.staged)
    if (staged.length > 0) {
      locked.push({
        title: 'chore: pre-staged changes',
        files: staged.map((file) => file.path),
      })
    }
    remaining.push(...files.filter((file) => !file.staged))
  } else {
    remaining.push(...files)
  }

  const hintGroups = new Map<string, string[]>()
  const candidates: FileChange[] = []

  for (const file of remaining) {
    const hint = config.grouping.hints.find((rule) =>
      safeMatch(rule.match, file.path),
    )
    if (hint) {
      const bucket = hintGroups.get(hint.group) ?? []
      bucket.push(file.path)
      hintGroups.set(hint.group, bucket)
    } else {
      candidates.push(file)
    }
  }

  const hinted: RawGroup[] = [...hintGroups].map(([title, paths]) => ({
    title,
    files: paths,
  }))

  return { locked, hinted, candidates }
}

/** An invalid user-supplied regex must not crash the run. */
function safeMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

/**
 * Enforce `grouping.maxCommits` by merging the smallest groups together.
 *
 * Merging is visible in the plan and reviewable, which is why it is preferred to
 * silently truncating — dropping groups would drop files.
 */
function capCommits(plan: CommitPlan, config: Config): CommitPlan {
  const limit = config.grouping.maxCommits
  if (plan.commits.length <= limit) return plan

  const keep = plan.commits.slice(0, limit - 1)
  const overflow = plan.commits.slice(limit - 1)

  keep.push({
    id: `c${limit}`,
    title: 'chore: remaining changes',
    body: `Merged ${overflow.length} groups to stay within maxCommits (${limit}).`,
    files: overflow.flatMap((commit) => commit.files),
    locked: false,
    warnings: [`Merged from: ${overflow.map((c) => c.title).join('; ')}`],
  })

  return { ...plan, commits: keep }
}
