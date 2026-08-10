import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { splitNul, type Git } from './exec.js'
import type { FileChange, FileStatus, WorkingTreeState } from '../engine/types.js'

/**
 * The hash of git's empty tree. Diffing against this makes an unborn branch
 * (a repo with no commits) behave exactly like any other repo, instead of
 * needing a special case at every call site.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Read everything the engine needs to know about the working tree.
 *
 * Includes tracked changes and untracked-but-not-ignored files. Untracked files
 * are included deliberately: a new feature's new files belong in that feature's
 * commit, and omitting them would produce commits that do not build.
 *
 * Note that this function never writes. In particular it does NOT use
 * `git add -N` to make untracked files visible to `git diff` — that would mutate
 * the index and destroy our ability to tell what the user had already staged.
 */
export async function readWorkingTree(git: Git): Promise<WorkingTreeState> {
  const root = (await git.run(['rev-parse', '--show-toplevel'])).trim()

  const headResult = await git.runRaw(['rev-parse', 'HEAD'])
  const head = headResult.code === 0 ? headResult.stdout.trim() : null

  const branchResult = await git.runRaw(['symbolic-ref', '--short', '--quiet', 'HEAD'])
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null
  const detached = branchResult.code !== 0 && head !== null

  const files = await readStatus(git)
  await attachLineCounts(git, root, files, head)

  return {
    root,
    head,
    branch,
    files,
    // Callers needing operation state should use `preflight`, which explains
    // itself; this field exists so a plan carries the context it was made in.
    operation: 'none',
    detached,
  }
}

/**
 * Parse `git status --porcelain=v2 -z`.
 *
 * Record formats (fields space-separated, records NUL-separated):
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>  + NUL + <origPath>
 *   u ... <path>          (unmerged)
 *   ? <path>              (untracked)
 *
 * The `2` record is the awkward one: its original path is a *separate*
 * NUL-delimited field, so the iterator has to consume an extra token.
 */
async function readStatus(git: Git): Promise<FileChange[]> {
  const raw = await git.run([
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ])

  const tokens = splitNul(raw)
  const files: FileChange[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.length === 0) continue

    const kind = token[0]!

    if (kind === '?') {
      files.push(blank(token.slice(2), 'untracked', false))
      continue
    }

    if (kind === '1' || kind === '2') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const staged = xy[0] !== '.'

      if (kind === '1') {
        // Path is everything after the 8th space-separated field.
        const path = fields.slice(8).join(' ')
        files.push(blank(path, statusFromXY(xy), staged))
      } else {
        const path = fields.slice(9).join(' ')
        const origPath = tokens[++i] ?? ''
        const change = blank(path, 'renamed', staged)
        change.origPath = origPath
        files.push(change)
      }
      continue
    }

    // 'u' (unmerged) is unreachable in practice — preflight refuses to run
    // during a merge — but skipping is safer than guessing.
  }

  return files
}

function statusFromXY(xy: string): FileStatus {
  const index = xy[0] ?? '.'
  const worktree = xy[1] ?? '.'
  const code = index !== '.' ? index : worktree

  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    default:
      return 'modified'
  }
}

function blank(path: string, status: FileStatus, staged: boolean): FileChange {
  return {
    path,
    status,
    staged,
    insertions: 0,
    deletions: 0,
    binary: false,
  }
}

/**
 * Fill in insertions, deletions, and binary flags.
 *
 * Tracked files come from `git diff --numstat` against HEAD, which covers staged
 * and unstaged changes together — the total change the commit will contain.
 * Untracked files are absent from that diff, so they are measured from disk.
 */
async function attachLineCounts(
  git: Git,
  root: string,
  files: FileChange[],
  head: string | null,
): Promise<void> {
  const stats = await readNumstat(git, head ?? EMPTY_TREE)

  await Promise.all(
    files.map(async (file) => {
      const stat = stats.get(file.path)
      if (stat) {
        file.insertions = stat.insertions
        file.deletions = stat.deletions
        file.binary = stat.binary
        return
      }
      if (file.status === 'untracked') {
        Object.assign(file, await measureUntracked(join(root, file.path)))
      }
    }),
  )
}

interface LineStat {
  insertions: number
  deletions: number
  binary: boolean
}

async function readNumstat(
  git: Git,
  base: string,
): Promise<Map<string, LineStat>> {
  const result = await git.runRaw(['diff', '--numstat', '-z', base, '--'])
  const stats = new Map<string, LineStat>()
  if (result.code !== 0) return stats

  const tokens = splitNul(result.stdout)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const [ins = '', del = '', inlinePath = ''] = token.split('\t')

    // A rename emits "ins\tdel\t" with the path left empty, followed by two
    // further NUL-delimited fields: the old path, then the new one.
    let path = inlinePath
    if (path === '') {
      i++ // skip old path
      path = tokens[++i] ?? ''
    }
    if (path === '') continue

    const binary = ins === '-' || del === '-'
    stats.set(path, {
      insertions: binary ? 0 : Number(ins) || 0,
      deletions: binary ? 0 : Number(del) || 0,
      binary,
    })
  }

  return stats
}

async function measureUntracked(absolutePath: string): Promise<LineStat> {
  try {
    const buffer = await readFile(absolutePath)
    // git's own heuristic: a NUL byte in the first 8000 bytes means binary.
    const window = buffer.subarray(0, 8000)
    if (window.includes(0)) return { insertions: 0, deletions: 0, binary: true }

    const text = buffer.toString('utf8')
    if (text.length === 0) return { insertions: 0, deletions: 0, binary: false }

    const newlines = text.split('\n').length - 1
    return {
      insertions: text.endsWith('\n') ? newlines : newlines + 1,
      deletions: 0,
      binary: false,
    }
  } catch {
    // Deleted between status and read, or unreadable. Not fatal.
    return { insertions: 0, deletions: 0, binary: false }
  }
}
