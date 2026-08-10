/**
 * Core data types shared across unbraid.
 *
 * The engine is a pure function `(WorkingTreeState, Config) -> CommitPlan`.
 * Everything in this file is plain data with no behaviour, so it can cross the
 * process boundary as JSON — that is what makes `unbraid plan --json` and any
 * future GUI possible without reimplementing the engine.
 */

export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'

/** One changed path in the working tree. */
export interface FileChange {
  path: string
  /** Present only when `status === 'renamed'`. */
  origPath?: string
  status: FileStatus
  /** True when the file is already in the index (porcelain v2 `X != '.'`). */
  staged: boolean
  insertions: number
  deletions: number
  binary: boolean
  /**
   * True when `path` is an untracked directory standing in for the files
   * beneath it. Staging the directory stages all of them, so no file is lost.
   */
  collapsed?: boolean
  /** How many files a collapsed directory represents. */
  fileCount?: number
}

/** An in-progress git operation that makes it unsafe to create commits. */
export type GitOperation =
  | 'none'
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect'

/** Everything the engine needs to know about the repository. */
export interface WorkingTreeState {
  root: string
  /** `null` on an unborn branch (a repo with no commits yet). */
  head: string | null
  branch: string | null
  files: FileChange[]
  operation: GitOperation
  detached: boolean
}

/** A single commit unbraid intends to create. */
export interface PlannedCommit {
  id: string
  /** e.g. "feat(auth): add refresh token rotation" */
  title: string
  body: string | null
  files: string[]
  /**
   * Hunk ids (`path#0`, `path#1`, …) this commit takes from files it shares
   * with other commits. Absent means the commit takes its files whole.
   */
  hunks?: string[]
  /** True when these files were already staged; the model never saw them. */
  locked: boolean
  /** Advisory notes, e.g. "also contains an unrelated rename". */
  warnings: string[]
}

/**
 * The contract between the engine and every consumer (CLI, TUI, future GUI).
 * `version` exists so a stored plan can be validated before `apply --plan`.
 */
export interface CommitPlan {
  version: 1
  commits: PlannedCommit[]
  /**
   * Files the model failed to place. Never silently dropped — the CLI surfaces
   * these as an editable catch-all group.
   */
  unassigned: string[]
}

/** A group exactly as the model returned it, before any validation. */
export interface RawGroup {
  title: string
  body?: string | null
  files: string[]
  /** Hunk ids, when the model split a file across commits. */
  hunks?: string[]
  warnings?: string[]
}

/** A pre-staged group, passed through untouched. */
export interface LockedGroup {
  title: string
  body?: string | null
  files: string[]
}
