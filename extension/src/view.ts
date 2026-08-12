import type { CommitPlan, WorkingTreeState } from 'unbraid'

/**
 * The shape the webview renders.
 *
 * Deriving this in the extension rather than in the webview keeps the panel
 * script dumb: it draws what it is handed. It also means the transform is a
 * pure function that can be tested without a browser or an extension host.
 */
export interface CommitView {
  id: string
  index: number
  title: string
  body: string | null
  locked: boolean
  warnings: string[]
  files: FileView[]
  /** Human summary such as "374 files in 1 entry". */
  fileSummary: string
}

export interface FileView {
  path: string
  /** Set when only part of the file goes into this commit. */
  partial: number | null
  /** Number of files a collapsed directory stands for. */
  collapsed: number | null
}

export interface PlanView {
  commits: CommitView[]
  unassigned: string[]
  totalFiles: number
}

export function toPlanView(plan: CommitPlan, state: WorkingTreeState): PlanView {
  const byPath = new Map(state.files.map((file) => [file.path, file]))

  const commits = plan.commits.map((commit, index) => {
    const files: FileView[] = commit.files.map((path) => {
      const change = byPath.get(path)
      const partial = (commit.hunks ?? []).filter(
        (id) => id.slice(0, id.lastIndexOf('#')) === path,
      ).length

      return {
        path,
        partial: partial > 0 ? partial : null,
        collapsed: change?.collapsed ? (change.fileCount ?? null) : null,
      }
    })

    return {
      id: commit.id,
      index,
      title: commit.title,
      body: commit.body,
      locked: commit.locked,
      warnings: commit.warnings,
      files,
      fileSummary: summarise(files),
    }
  })

  return {
    commits,
    unassigned: plan.unassigned,
    totalFiles: countFiles(commits),
  }
}

/**
 * A collapsed directory is one entry standing for many files. Reporting it as
 * "1 file" is true of the plan and misleading to the person approving it.
 */
export function summarise(files: FileView[]): string {
  const real = files.reduce((total, file) => total + (file.collapsed ?? 1), 0)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  if (files.every((file) => file.collapsed === null)) return plural(real, 'file')
  return `${plural(real, 'file')} in ${files.length === 1 ? '1 entry' : `${files.length} entries`}`
}

function countFiles(commits: CommitView[]): number {
  return commits.reduce(
    (total, commit) =>
      total + commit.files.reduce((n, file) => n + (file.collapsed ?? 1), 0),
    0,
  )
}
