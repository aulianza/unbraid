import type { Git } from './exec.js'
import { applyHunks, parseHunks, verifyRoundTrip, type Hunk } from './hunks.js'
import { readAtCommit, stageContent } from './blob.js'
import type { CommitPlan } from '../engine/types.js'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface HunkContext {
  /** Every hunk of every splittable file, keyed by path, in file order. */
  hunksByPath: Map<string, Hunk[]>
  /** Content of each of those paths at HEAD. */
  baseByPath: Map<string, string>
}

/**
 * Read the hunks of every file a plan wants to split, and check each one can be
 * split safely.
 *
 * A file is only offered for splitting when applying all of its hunks to the
 * HEAD content reproduces the working tree byte for byte. If the round trip
 * fails, unbraid does not understand that diff well enough to take it apart, and
 * the file is left to be committed whole. That check is the reason this is safe
 * to enable.
 */
export async function buildHunkContext(
  git: Git,
  paths: string[],
  head: string | null,
): Promise<HunkContext> {
  const hunksByPath = new Map<string, Hunk[]>()
  const baseByPath = new Map<string, string>()
  const base = head ?? EMPTY_TREE

  for (const path of paths) {
    const diff = await git.runRaw(['diff', base, '--', path])
    if (diff.code !== 0 || diff.stdout.trim() === '') continue

    const hunks = parseHunks(diff.stdout, path)
    if (hunks.length < 2) continue // nothing to split

    const baseContent = await readAtCommit(git, base, path)
    const worktree = await readWorktree(git, path)
    if (worktree === null) continue

    if (!verifyRoundTrip(baseContent, hunks, worktree)) continue

    hunksByPath.set(path, hunks)
    baseByPath.set(path, baseContent)
  }

  return { hunksByPath, baseByPath }
}

async function readWorktree(git: Git, path: string): Promise<string | null> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  try {
    return await readFile(join(git.cwd, path), 'utf8')
  } catch {
    return null // deleted, binary, or unreadable — not splittable
  }
}

/**
 * Stage the content a file should have as of a given commit in the plan.
 *
 * Content is cumulative: commit N stages the base plus every hunk assigned to
 * commits 1..N. That is what makes each commit's own diff contain only its own
 * hunks, and it means the final commit reproduces the working tree exactly.
 */
export async function stageHunksForCommit(
  git: Git,
  plan: CommitPlan,
  commitIndex: number,
  path: string,
  context: HunkContext,
): Promise<void> {
  const allHunks = context.hunksByPath.get(path)
  const base = context.baseByPath.get(path)
  if (!allHunks || base === undefined) {
    throw new Error(`No hunk context for ${path}`)
  }

  const assigned = new Set<string>()
  for (let i = 0; i <= commitIndex; i++) {
    for (const id of plan.commits[i]?.hunks ?? []) assigned.add(id)
  }

  const selected = allHunks.filter((hunk) => assigned.has(hunk.id))
  await stageContent(git, path, applyHunks(base, selected))
}

/** Paths a commit stages by hunk rather than wholesale. */
export function hunkPathsFor(
  commit: CommitPlan['commits'][number],
  context: HunkContext,
): string[] {
  const paths = new Set<string>()
  for (const id of commit.hunks ?? []) {
    const path = id.slice(0, id.lastIndexOf('#'))
    if (context.hunksByPath.has(path)) paths.add(path)
  }
  return [...paths]
}
