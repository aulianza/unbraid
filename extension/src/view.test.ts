import { describe, it, expect } from 'vitest'
import { toPlanView, summarise, type FileView } from './view.js'
import { readSettings } from './settings.js'
import type { CommitPlan, WorkingTreeState } from 'unbraid'

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
  branch: 'main',
  files,
  operation: 'none',
  detached: false,
})

describe('toPlanView', () => {
  it('numbers commits and carries their text through', () => {
    const plan: CommitPlan = {
      version: 1,
      unassigned: [],
      commits: [
        { id: 'c1', title: 'feat: a', body: 'why', files: ['a.ts'], locked: false, warnings: [] },
        { id: 'c2', title: 'fix: b', body: null, files: ['b.ts'], locked: true, warnings: ['note'] },
      ],
    }

    const view = toPlanView(plan, tree([file('a.ts'), file('b.ts')]))

    expect(view.commits.map((c) => c.index)).toEqual([0, 1])
    expect(view.commits[0]!.body).toBe('why')
    expect(view.commits[1]!.locked).toBe(true)
    expect(view.commits[1]!.warnings).toEqual(['note'])
  })

  it('marks a file taken only in part', () => {
    const plan: CommitPlan = {
      version: 1,
      unassigned: [],
      commits: [
        {
          id: 'c1',
          title: 'fix',
          body: null,
          files: ['a.ts'],
          hunks: ['a.ts#0', 'a.ts#2'],
          locked: false,
          warnings: [],
        },
      ],
    }

    expect(toPlanView(plan, tree([file('a.ts')])).commits[0]!.files[0]!.partial).toBe(2)
  })

  it('carries the real size of a collapsed directory', () => {
    const plan: CommitPlan = {
      version: 1,
      unassigned: [],
      commits: [
        { id: 'c1', title: 'feat', body: null, files: ['landing/'], locked: false, warnings: [] },
      ],
    }

    const view = toPlanView(
      plan,
      tree([file('landing/', { collapsed: true, fileCount: 374, status: 'untracked' })]),
    )

    expect(view.commits[0]!.files[0]!.collapsed).toBe(374)
    expect(view.totalFiles).toBe(374)
  })

  it('passes unassigned files through', () => {
    const plan: CommitPlan = {
      version: 1,
      unassigned: ['orphan.ts'],
      commits: [
        { id: 'c1', title: 'feat', body: null, files: ['a.ts'], locked: false, warnings: [] },
      ],
    }

    expect(toPlanView(plan, tree([file('a.ts')])).unassigned).toEqual(['orphan.ts'])
  })
})

describe('summarise', () => {
  const plain = (path: string): FileView => ({ path, partial: null, collapsed: null })

  it.each([
    [[plain('a.ts')], '1 file'],
    [[plain('a.ts'), plain('b.ts')], '2 files'],
  ])('%j -> %s', (files, expected) => {
    expect(summarise(files)).toBe(expected)
  })

  // "1 file" for a directory holding 374 of them is true of the plan and
  // misleading to the person approving it.
  it('reports the real count behind a collapsed directory', () => {
    expect(summarise([{ path: 'landing/', partial: null, collapsed: 374 }])).toBe(
      '374 files in 1 entry',
    )
  })

  it('mixes collapsed directories and plain files', () => {
    expect(
      summarise([plain('a.ts'), { path: 'landing/', partial: null, collapsed: 10 }]),
    ).toBe('11 files in 2 entries')
  })
})

describe('readSettings', () => {
  /** Mirrors VS Code's inspect(), which distinguishes set from defaulted. */
  const config = (set: Record<string, unknown>) => ({
    inspect<T>(section: string) {
      return section in set
        ? { globalValue: set[section] as T }
        : ({} as { globalValue?: T })
    },
  })

  // `get` would return the schema default and silently override a repository's
  // own .unbraidrc.yaml with a value the user never chose.
  it('forwards nothing when the user has set nothing', () => {
    expect(readSettings(config({}))).toEqual({})
  })

  it('forwards an explicitly chosen granularity', () => {
    expect(readSettings(config({ granularity: 'fine' }))).toEqual({
      grouping: { granularity: 'fine' },
    })
  })

  it('forwards hunks when enabled', () => {
    expect(readSettings(config({ hunks: true }))).toEqual({ grouping: { hunks: true } })
  })

  it('treats provider "auto" as no opinion', () => {
    expect(readSettings(config({ provider: 'auto' }))).toEqual({})
  })

  it('forwards an explicit provider', () => {
    expect(readSettings(config({ provider: 'anthropic' }))).toEqual({
      provider: 'anthropic',
    })
  })

  it('prefers a workspace value over a global one', () => {
    const mixed = {
      inspect<T>() {
        return { globalValue: 'coarse' as T, workspaceValue: 'fine' as T }
      },
    }
    expect(readSettings(mixed).grouping?.granularity).toBe('fine')
  })
})
