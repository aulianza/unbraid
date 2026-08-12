import { describe, it, expect } from 'vitest'
import { toFileGroups, untrackedPaths, describeDiscard } from './file-list.js'
import { describeSync } from './git-ops.js'
import type { WorkingTreeState } from 'unbraid'

const file = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  status: 'modified' as const,
  staged: false,
  insertions: 1,
  deletions: 0,
  binary: false,
  ...extra,
})

const tree = (files: ReturnType<typeof file>[]): WorkingTreeState => ({
  root: '/repo',
  head: 'abc',
  branch: 'development',
  files,
  operation: 'none',
  detached: false,
})

describe('toFileGroups', () => {
  it('separates staged from unstaged', () => {
    const groups = toFileGroups(
      tree([file('a.ts', { staged: true }), file('b.ts'), file('c.ts', { staged: true })]),
    )
    expect(groups.staged.map((r) => r.path)).toEqual(['a.ts', 'c.ts'])
    expect(groups.changes.map((r) => r.path)).toEqual(['b.ts'])
  })

  // The filename is what the eye scans for; the directory is context.
  it('splits the path into name and directory', () => {
    const [row] = toFileGroups(tree([file('src/components/Header.tsx')])).changes
    expect(row!.name).toBe('Header.tsx')
    expect(row!.dir).toBe('src/components')
  })

  it('handles a file at the root', () => {
    const [row] = toFileGroups(tree([file('README.md')])).changes
    expect(row!.name).toBe('README.md')
    expect(row!.dir).toBe('')
  })

  it('names a collapsed directory without its trailing slash', () => {
    const [row] = toFileGroups(
      tree([file('landing/', { status: 'untracked', collapsed: true, fileCount: 374 })]),
    ).changes
    expect(row!.name).toBe('landing')
    expect(row!.collapsed).toBe(374)
  })

  it.each([
    ['added', 'A'],
    ['modified', 'M'],
    ['deleted', 'D'],
    ['renamed', 'R'],
    ['untracked', 'U'],
  ])('shows %s as %s', (status, letter) => {
    const [row] = toFileGroups(tree([file('a.ts', { status })])).changes
    expect(row!.letter).toBe(letter)
  })
})

describe('untrackedPaths', () => {
  // Discarding an untracked file deletes it; `git restore` silently does
  // nothing for those, which would look like a no-op bug.
  it('lists only files with no committed state', () => {
    const groups = toFileGroups(
      tree([file('a.ts'), file('new.ts', { status: 'untracked' })]),
    )
    expect(untrackedPaths(groups)).toEqual(['new.ts'])
  })
})

describe('describeDiscard', () => {
  it('says revert when the file is tracked', () => {
    const rows = toFileGroups(tree([file('a.ts')])).changes
    expect(describeDiscard(rows)).toMatch(/revert 1 file/)
    expect(describeDiscard(rows)).not.toMatch(/delete/)
  })

  // Deleting a new file is worse than reverting an edit: the edit still exists
  // in git's history, the file does not.
  it('says permanently delete when the file is new', () => {
    const rows = toFileGroups(tree([file('new.ts', { status: 'untracked' })])).changes
    expect(describeDiscard(rows)).toMatch(/permanently delete 1 new file/)
  })

  it('says both when the selection mixes them', () => {
    const rows = toFileGroups(
      tree([file('a.ts'), file('new.ts', { status: 'untracked' })]),
    ).changes
    const text = describeDiscard(rows)
    expect(text).toMatch(/revert 1 file/)
    expect(text).toMatch(/permanently delete 1 new file/)
    expect(text).toMatch(/cannot be undone/)
  })
})

describe('describeSync', () => {
  const info = (extra: Record<string, unknown> = {}) => ({
    branch: 'development',
    upstream: 'origin/development',
    ahead: 0,
    behind: 0,
    detached: false,
    ...extra,
  })

  it.each([
    [info(), 'up to date'],
    [info({ ahead: 3 }), '3 to push'],
    [info({ behind: 2 }), '2 to pull'],
    [info({ ahead: 1, behind: 2 }), '1 to push, 2 to pull'],
    [info({ upstream: null }), 'not published'],
    [info({ branch: null, detached: true }), 'detached HEAD'],
  ])('%j -> %s', (value, expected) => {
    expect(describeSync(value)).toBe(expected)
  })
})
