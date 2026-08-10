import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import picomatch from 'picomatch'
import type { Git } from './exec.js'
import type { FileChange } from '../engine/types.js'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface DiffOptions {
  /** Keep only the first N lines of each diff. 0 or undefined means no limit. */
  truncateLines?: number
  /** Hard ceiling on the combined size of all diff text, in bytes. */
  maxBytes?: number
  /** Glob patterns whose contents are withheld from the model. */
  exclude?: string[]
}

export interface FileDiff {
  path: string
  /** Unified diff text. Empty when `omitted` is true. */
  diff: string
  truncated: boolean
  /** True when content was deliberately withheld (binary, excluded, or over budget). */
  omitted: boolean
  /** Why it was omitted — surfaced so the model is told, not left guessing. */
  omittedReason?: 'binary' | 'excluded' | 'budget'
}

/**
 * Collect per-file diffs for the model.
 *
 * Exclusion here means "do not spend tokens on this", NOT "do not commit this".
 * An excluded file still appears in the plan and is still committed — only its
 * contents are withheld. Conflating the two would silently drop user work.
 */
export async function collectDiffs(
  git: Git,
  files: FileChange[],
  head: string | null,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  const { truncateLines = 0, maxBytes = 0, exclude = [] } = options

  const isExcluded =
    exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false

  const root = (await git.run(['rev-parse', '--show-toplevel'])).trim()
  const base = head ?? EMPTY_TREE

  const results: FileDiff[] = []
  let budgetUsed = 0

  for (const file of files) {
    if (file.binary) {
      results.push(omit(file.path, 'binary'))
      continue
    }
    if (isExcluded(file.path)) {
      results.push(omit(file.path, 'excluded'))
      continue
    }
    if (maxBytes > 0 && budgetUsed >= maxBytes) {
      results.push(omit(file.path, 'budget'))
      continue
    }

    const raw =
      file.status === 'untracked'
        ? await readUntrackedAsDiff(join(root, file.path), file.path)
        : (await git.runRaw(['diff', base, '--', file.path])).stdout

    const { text, truncated } = truncate(raw, truncateLines)
    budgetUsed += Buffer.byteLength(text, 'utf8')

    results.push({ path: file.path, diff: text, truncated, omitted: false })
  }

  return results
}

function omit(path: string, reason: FileDiff['omittedReason']): FileDiff {
  return { path, diff: '', truncated: false, omitted: true, omittedReason: reason }
}

function truncate(
  raw: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (limit <= 0) return { text: raw, truncated: false }

  const lines = raw.split('\n')
  if (lines.length <= limit) return { text: raw, truncated: false }

  const kept = lines.slice(0, limit).join('\n')
  const hidden = lines.length - limit
  return {
    text: `${kept}\n… ${hidden} more line${hidden === 1 ? '' : 's'} truncated`,
    truncated: true,
  }
}

/**
 * Render an untracked file as an all-additions diff.
 *
 * Untracked files are invisible to `git diff`. The alternative — `git add -N` —
 * would make them visible but mutates the index, which would corrupt our record
 * of what the user had already staged. Synthesising the diff keeps the working
 * tree and index untouched.
 */
async function readUntrackedAsDiff(
  absolutePath: string,
  displayPath: string,
): Promise<string> {
  try {
    const content = await readFile(absolutePath, 'utf8')
    const body = content
      .split('\n')
      .map((line) => `+${line}`)
      .join('\n')
    return `--- /dev/null\n+++ b/${displayPath}\n${body}`
  } catch {
    return ''
  }
}
