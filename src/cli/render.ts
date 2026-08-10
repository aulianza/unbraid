import type { CommitPlan, WorkingTreeState } from '../core/engine/types.js'

const supportsColour =
  process.stdout.isTTY && process.env.NO_COLOR === undefined

const paint = (code: string, text: string) =>
  supportsColour ? `\u001b[${code}m${text}\u001b[0m` : text

export const dim = (text: string) => paint('2', text)
export const bold = (text: string) => paint('1', text)
export const cyan = (text: string) => paint('36', text)
export const yellow = (text: string) => paint('33', text)
export const red = (text: string) => paint('31', text)
export const green = (text: string) => paint('32', text)

/**
 * Describe how many files a plan entry really covers.
 *
 * A collapsed directory is one entry but many files. Printing "1 file" for a
 * directory holding 374 of them is technically true of the plan and actively
 * misleading to the person approving it.
 */
export function describeFileCount(
  paths: string[],
  state: WorkingTreeState,
): string {
  let real = 0
  let collapsedDirs = 0

  for (const path of paths) {
    const change = state.files.find((file) => file.path === path)
    if (change?.collapsed) {
      real += change.fileCount ?? 1
      collapsedDirs++
    } else {
      real += 1
    }
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  if (collapsedDirs === 0) return plural(real, 'file')
  return `${plural(real, 'file')} in ${plural(paths.length, 'entry').replace('entrys', 'entries')}`
}

export function renderPlan(plan: CommitPlan, state: WorkingTreeState): string {
  const lines: string[] = []

  for (const [index, commit] of plan.commits.entries()) {
    const marker = commit.locked ? yellow(' [pre-staged]') : ''
    lines.push(
      `${bold(cyan(`${index + 1}.`))} ${bold(commit.title)}${marker}`,
      `   ${dim(describeFileCount(commit.files, state))}`,
    )

    if (commit.body) {
      lines.push(...commit.body.split('\n').map((line) => `   ${dim(line)}`))
    }

    for (const path of commit.files.slice(0, 8)) {
      const change = state.files.find((file) => file.path === path)
      // A partially-taken file must say so, or the plan reads as if the whole
      // file is going into this commit.
      const taken = (commit.hunks ?? []).filter(
        (id) => id.slice(0, id.lastIndexOf('#')) === path,
      ).length
      const suffix = change?.collapsed
        ? dim(` (${change.fileCount} files)`)
        : taken > 0
          ? yellow(` (${taken} of its changes)`)
          : ''
      lines.push(`     ${dim('·')} ${path}${suffix}`)
    }
    if (commit.files.length > 8) {
      lines.push(`     ${dim(`… ${commit.files.length - 8} more`)}`)
    }

    for (const warning of commit.warnings) {
      lines.push(`   ${yellow('!')} ${yellow(warning)}`)
    }
    lines.push('')
  }

  if (plan.unassigned.length > 0) {
    lines.push(
      yellow(`Unassigned (${plan.unassigned.length}) — review before committing:`),
      ...plan.unassigned.map((path) => `     ${dim('·')} ${path}`),
      '',
    )
  }

  return lines.join('\n')
}
