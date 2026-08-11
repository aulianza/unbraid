import type {
  CommitPlan,
  LockedGroup,
  PlannedCommit,
  RawGroup,
} from './types.js'

export interface ReconcileInput {
  /** Groups exactly as the model returned them. Assumed untrustworthy. */
  groups: RawGroup[]
  /** Every path that must be accounted for, in working-tree order. */
  realFiles: string[]
  /** Pre-staged groups. Passed through untouched and always placed first. */
  locked?: LockedGroup[]
  /**
   * Every hunk id that exists, when hunk splitting is enabled.
   *
   * Hunks get the same treatment as files: invented ids are dropped, an id
   * claimed twice stays with the first claimant, and any hunk nobody claimed is
   * assigned to the last commit touching its file so no change is left behind.
   */
  availableHunks?: string[]
}

/**
 * Validate a model's grouping against reality and produce a `CommitPlan`.
 *
 * This function is the mechanism behind unbraid's second invariant — never lose
 * a file. It does not ask the model to be careful; it assumes the model was not.
 *
 * Rules, applied in order:
 *   1. Locked (pre-staged) groups come first and are never modified.
 *   2. Paths absent from `realFiles` are dropped and recorded as a warning.
 *   3. A path claimed by several groups is kept by the first one only.
 *   4. Groups left with no files are pruned.
 *   5. Any remaining unaccounted path lands in `unassigned`.
 *
 * Pure: no I/O, no clock, no randomness. Same input, same output, always.
 */
/** `src/a.ts#3` -> `src/a.ts`. Paths may contain '#', so take the last one. */
function pathOfHunk(id: string): string {
  return id.slice(0, id.lastIndexOf('#'))
}

export function reconcile(input: ReconcileInput): CommitPlan {
  const { groups, realFiles, locked = [], availableHunks = [] } = input

  const real = new Set(realFiles)
  const realHunks = new Set(availableHunks)
  const claimedHunks = new Set<string>()
  const claimed = new Set<string>()
  const commits: PlannedCommit[] = []

  let counter = 0
  const nextId = () => `c${++counter}`

  // 1. Locked groups first. These were already staged by the user, so they are
  //    authoritative — we only filter to paths that genuinely exist.
  for (const group of locked) {
    const files = group.files.filter((f) => real.has(f) && !claimed.has(f))
    for (const f of files) claimed.add(f)

    // A locked group is preserved even when empty: the user staged it
    // deliberately, and silently dropping it would be surprising.
    commits.push({
      id: nextId(),
      title: group.title,
      body: group.body ?? null,
      files,
      locked: true,
      warnings: [],
    })
  }

  // 2-4. Model groups, in the order the model proposed them.
  for (const group of groups) {
    const warnings = [...(group.warnings ?? [])]
    const files: string[] = []
    const hallucinated: string[] = []

    // Hunks first: a file being split is claimed by every commit that takes a
    // hunk from it, so it must not be consumed by the whole-file pass below.
    const hunks: string[] = []
    for (const id of group.hunks ?? []) {
      if (!realHunks.has(id) || claimedHunks.has(id)) continue
      hunks.push(id)
      claimedHunks.add(id)
    }
    const splitPaths = new Set(hunks.map(pathOfHunk))

    for (const file of group.files) {
      if (!real.has(file)) {
        hallucinated.push(file)
        continue
      }
      // A split file is legitimately listed by several commits.
      if (splitPaths.has(file)) {
        files.push(file)
        continue
      }
      if (claimed.has(file)) continue // already taken by an earlier group
      files.push(file)
      claimed.add(file)
    }

    // A commit may name hunks without naming their file.
    for (const path of splitPaths) {
      if (!files.includes(path)) files.push(path)
    }

    if (hallucinated.length > 0) {
      warnings.push(
        `Dropped ${hallucinated.length} path(s) not present in the working tree: ${hallucinated.join(', ')}`,
      )
    }

    if (files.length === 0) continue // prune

    commits.push({
      id: nextId(),
      title: group.title,
      body: group.body ?? null,
      files,
      ...(hunks.length > 0 ? { hunks } : {}),
      locked: false,
      warnings,
    })
  }

  // Leftover hunks, but only for files that were actually split.
  //
  // A file with none of its hunks claimed is not a mistake: it means the model
  // saw no reason to split it, so it is committed whole. Treating that as
  // "forgotten" produced a warning per hunk on a completely ordinary plan.
  // A file with *some* hunks claimed and others left behind is the real
  // problem, because the leftovers would never reach any commit.
  const partiallyClaimed = new Set(
    availableHunks
      .filter((id) => claimedHunks.has(id))
      .map(pathOfHunk),
  )

  for (const id of availableHunks) {
    if (claimedHunks.has(id)) continue
    const path = pathOfHunk(id)
    if (!partiallyClaimed.has(path)) continue // whole file, nothing to reconcile

    const target = [...commits].reverse().find(
      (commit) => !commit.locked && commit.files.includes(path),
    )
    if (!target) continue
    target.hunks = [...(target.hunks ?? []), id]
    target.warnings.push(`Unassigned hunk ${id} was added here.`)
    claimedHunks.add(id)
  }

  // 5. Whatever is left was forgotten. Surface it rather than lose it.
  const splitPaths = new Set([...claimedHunks].map(pathOfHunk))
  const unassigned = realFiles.filter(
    (f) => !claimed.has(f) && !splitPaths.has(f),
  )

  return { version: 1, commits, unassigned }
}
