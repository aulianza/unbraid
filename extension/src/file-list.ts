import type { FileChange, WorkingTreeState } from 'unbraid'

/**
 * The changed-file list, shaped for display.
 *
 * Splitting staged from unstaged mirrors what people already read in Source
 * Control, and unbraid treats the two differently — pre-staged files become a
 * locked group the model never regroups — so the distinction is not cosmetic.
 */

export interface FileRow {
  path: string
  /** Just the filename, which is what the eye actually scans for. */
  name: string
  /** The directory, shown dimmed after the name. */
  dir: string
  /** Single letter, as git and every git UI use: M, A, D, R, U. */
  letter: string
  status: FileChange['status']
  staged: boolean
  untracked: boolean
  insertions: number
  deletions: number
  /** Number of files a collapsed directory stands for. */
  collapsed: number | null
}

export interface FileGroups {
  staged: FileRow[]
  changes: FileRow[]
  branch: string | null
}

const LETTERS: Record<FileChange['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

export function toFileGroups(state: WorkingTreeState): FileGroups {
  const rows = state.files.map(toRow)

  return {
    staged: rows.filter((row) => row.staged),
    changes: rows.filter((row) => !row.staged),
    branch: state.branch,
  }
}

function toRow(file: FileChange): FileRow {
  const trimmed = file.path.replace(/\/$/, '')
  const slash = trimmed.lastIndexOf('/')

  return {
    path: file.path,
    name: slash === -1 ? trimmed : trimmed.slice(slash + 1),
    dir: slash === -1 ? '' : trimmed.slice(0, slash),
    letter: LETTERS[file.status],
    status: file.status,
    staged: file.staged,
    untracked: file.status === 'untracked',
    insertions: file.insertions,
    deletions: file.deletions,
    collapsed: file.collapsed ? (file.fileCount ?? null) : null,
  }
}

/** Paths that have no committed state, so discarding means deleting them. */
export function untrackedPaths(groups: FileGroups): string[] {
  return [...groups.staged, ...groups.changes]
    .filter((row) => row.untracked)
    .map((row) => row.path)
}

/**
 * What to warn before discarding.
 *
 * Discard is the one destructive action in the panel, and deleting a new file is
 * meaningfully worse than reverting an edit — the edit still exists in git's
 * history, the file does not.
 */
export function describeDiscard(rows: FileRow[]): string {
  const deletions = rows.filter((row) => row.untracked).length
  const reverts = rows.length - deletions

  const parts: string[] = []
  if (reverts > 0) parts.push(`revert ${reverts} file${reverts === 1 ? '' : 's'}`)
  if (deletions > 0) {
    parts.push(`permanently delete ${deletions} new file${deletions === 1 ? '' : 's'}`)
  }

  return `This will ${parts.join(' and ')}. It cannot be undone.`
}
