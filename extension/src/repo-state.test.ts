import { describe, it, expect } from 'vitest'
import { summariseRepo, statusLabel, statusTooltip, same } from './repo-state.js'
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

const tree = (files: ReturnType<typeof file>[], branch = 'main'): WorkingTreeState => ({
  root: '/repo',
  head: 'abc',
  branch,
  files,
  operation: 'none',
  detached: false,
})

describe('summariseRepo', () => {
  it('counts changed and staged files', () => {
    const summary = summariseRepo(
      tree([file('a.ts'), file('b.ts', { staged: true }), file('c.ts', { staged: true })]),
    )

    expect(summary.changed).toBe(3)
    expect(summary.staged).toBe(2)
    expect(summary.branch).toBe('main')
    expect(summary.clean).toBe(false)
  })

  it('reports a clean tree', () => {
    expect(summariseRepo(tree([])).clean).toBe(true)
  })

  // The same rule the plan uses: an entry standing for 374 files is not one file.
  it('counts a collapsed directory as its real contents', () => {
    const summary = summariseRepo(
      tree([file('a.ts'), file('landing/', { collapsed: true, fileCount: 374 })]),
    )
    expect(summary.changed).toBe(375)
  })
})

describe('statusLabel', () => {
  // A zero in an already-crowded status bar is noise, not information.
  it('is empty for a clean tree, so the item hides', () => {
    expect(statusLabel(summariseRepo(tree([])))).toBe('')
    expect(statusLabel(null)).toBe('')
  })

  it('is the change count otherwise', () => {
    expect(statusLabel(summariseRepo(tree([file('a.ts'), file('b.ts')])))).toBe('2')
  })
})

describe('statusTooltip', () => {
  it('names the branch and what clicking does', () => {
    const tip = statusTooltip(summariseRepo(tree([file('a.ts')], 'feat/x')))
    expect(tip).toContain('1 uncommitted file')
    expect(tip).toContain('feat/x')
    expect(tip).toContain('Click')
  })

  it('says so when there is nothing to do', () => {
    expect(statusTooltip(null)).toMatch(/nothing to commit/i)
  })
})

describe('same', () => {
  const summary = (changed: number, staged = 0, branch = 'main') => ({
    changed,
    staged,
    branch,
    clean: changed === 0,
  })

  // The webview is re-rendered on every change, so an unchanged count must not
  // count as a change — otherwise typing rebuilds the sidebar continuously.
  it('treats identical summaries as unchanged', () => {
    expect(same(summary(3), summary(3))).toBe(true)
  })

  it.each([
    [summary(3), summary(4), 'file count'],
    [summary(3, 0), summary(3, 1), 'staged count'],
    [summary(3, 0, 'main'), summary(3, 0, 'dev'), 'branch'],
  ])('notices a change in %s', (a, b) => {
    expect(same(a, b)).toBe(false)
  })

  it('handles null on either side', () => {
    expect(same(null, null)).toBe(true)
    expect(same(null, summary(1))).toBe(false)
    expect(same(summary(1), null)).toBe(false)
  })
})
