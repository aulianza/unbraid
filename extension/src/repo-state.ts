import type { WorkingTreeState } from 'unbraid'

export interface RepoSummary {
  changed: number
  staged: number
  branch: string | null
  /** True when there is nothing for unbraid to do. */
  clean: boolean
}

/**
 * Reduce a working tree to what the sidebar and status bar need.
 *
 * Counting collapsed directories as their real contents, for the same reason
 * the plan does: an entry standing for 374 files should not read as one.
 */
export function summariseRepo(state: WorkingTreeState): RepoSummary {
  const changed = state.files.reduce(
    (total, file) => total + (file.collapsed ? (file.fileCount ?? 1) : 1),
    0,
  )
  const staged = state.files.filter((file) => file.staged).length

  return {
    changed,
    staged,
    branch: state.branch,
    clean: state.files.length === 0,
  }
}

/**
 * Short label for the status bar. An empty string means show nothing.
 *
 * A clean tree hides the item rather than displaying a zero: the status bar is
 * already crowded, and "0" is not information anyone needs.
 */
export function statusLabel(summary: RepoSummary | null): string {
  if (!summary || summary.clean) return ''
  return String(summary.changed)
}

export function statusTooltip(summary: RepoSummary | null): string {
  if (!summary || summary.clean) return 'unbraid — nothing to commit'
  const files = `${summary.changed} uncommitted file${summary.changed === 1 ? '' : 's'}`
  const branch = summary.branch ? ` on ${summary.branch}` : ''
  return `unbraid — ${files}${branch}. Click to create commits.`
}

/**
 * Whether two summaries are equivalent.
 *
 * Lives here rather than beside the watcher so it can be tested without an
 * extension host. The watcher uses it to skip re-rendering the webview when a
 * keystroke changed a file but not the counts.
 */
export function same(a: RepoSummary | null, b: RepoSummary | null): boolean {
  if (a === null || b === null) return a === b
  return a.changed === b.changed && a.staged === b.staged && a.branch === b.branch
}
