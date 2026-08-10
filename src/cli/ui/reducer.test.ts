import { describe, it, expect } from 'vitest'
import { reduce, initialState, type EditorState } from './reducer.js'
import { windowAround } from './App.js'
import type { CommitPlan } from '../../core/engine/types.js'

const commit = (id: string, title: string, files: string[], locked = false) => ({
  id,
  title,
  body: null,
  files,
  locked,
  warnings: [],
})

const plan = (): CommitPlan => ({
  version: 1,
  commits: [
    commit('c1', 'feat: alpha', ['a.ts']),
    commit('c2', 'fix: beta', ['b.ts']),
    commit('c3', 'chore: gamma', ['c.ts']),
  ],
  unassigned: [],
})

const start = (): EditorState => initialState(plan())

const run = (state: EditorState, ...actions: Parameters<typeof reduce>[1][]) =>
  actions.reduce(reduce, state)

describe('cursor', () => {
  it('moves within bounds', () => {
    expect(run(start(), { type: 'cursor', delta: 1 }).cursor).toBe(1)
  })

  it('does not move above the first commit', () => {
    expect(run(start(), { type: 'cursor', delta: -1 }).cursor).toBe(0)
  })

  it('does not move past the last commit', () => {
    const state = run(start(), { type: 'cursor', delta: 99 })
    expect(state.cursor).toBe(2)
  })
})

describe('expand', () => {
  it('toggles the file list', () => {
    let state = run(start(), { type: 'toggle-expand' })
    expect(state.expanded.has('c1')).toBe(true)
    state = run(state, { type: 'toggle-expand' })
    expect(state.expanded.has('c1')).toBe(false)
  })
})

describe('reorder', () => {
  it('moves a commit down and follows it with the cursor', () => {
    const state = run(start(), { type: 'move-commit', delta: 1 })
    expect(state.plan.commits.map((c) => c.id)).toEqual(['c2', 'c1', 'c3'])
    expect(state.cursor).toBe(1)
  })

  it('refuses to move past the ends', () => {
    const state = run(start(), { type: 'move-commit', delta: -1 })
    expect(state.plan.commits.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('merge', () => {
  it('folds a commit into the one above it', () => {
    const state = run(
      start(),
      { type: 'cursor', delta: 1 },
      { type: 'merge-up' },
    )

    expect(state.plan.commits).toHaveLength(2)
    expect(state.plan.commits[0]!.files).toEqual(['a.ts', 'b.ts'])
    expect(state.cursor).toBe(0)
  })

  it('does nothing at the top of the list', () => {
    const state = run(start(), { type: 'merge-up' })
    expect(state.plan.commits).toHaveLength(3)
  })

  it('refuses to merge a pre-staged commit', () => {
    const base = initialState({
      version: 1,
      commits: [
        commit('c1', 'chore: pre-staged', ['s.ts'], true),
        commit('c2', 'feat: work', ['w.ts']),
      ],
      unassigned: [],
    })

    const state = run(base, { type: 'cursor', delta: 1 }, { type: 'merge-up' })

    expect(state.plan.commits).toHaveLength(2)
    expect(state.notice).toMatch(/pre-staged/i)
  })

  it('joins both bodies rather than discarding one', () => {
    const base = initialState({
      version: 1,
      commits: [
        { ...commit('c1', 'a', ['a.ts']), body: 'first' },
        { ...commit('c2', 'b', ['b.ts']), body: 'second' },
      ],
      unassigned: [],
    })

    const state = run(base, { type: 'cursor', delta: 1 }, { type: 'merge-up' })
    expect(state.plan.commits[0]!.body).toBe('first\nsecond')
  })
})

describe('dissolve', () => {
  // The invariant that matters: removing a commit must never remove its files.
  it('moves files to unassigned rather than dropping them', () => {
    const state = run(start(), { type: 'dissolve' })

    expect(state.plan.commits).toHaveLength(2)
    expect(state.plan.unassigned).toEqual(['a.ts'])
  })

  it('refuses to remove a pre-staged commit', () => {
    const base = initialState({
      version: 1,
      commits: [commit('c1', 'chore: pre-staged', ['s.ts'], true)],
      unassigned: [],
    })

    const state = run(base, { type: 'dissolve' })
    expect(state.plan.commits).toHaveLength(1)
    expect(state.notice).toMatch(/pre-staged/i)
  })

  it('keeps the cursor in range after removing the last commit', () => {
    const state = run(
      start(),
      { type: 'cursor', delta: 2 },
      { type: 'dissolve' },
    )
    expect(state.cursor).toBe(1)
  })
})

describe('editing a title', () => {
  it('types, backspaces, and saves', () => {
    const state = run(
      start(),
      { type: 'begin-edit' },
      { type: 'edit-key', input: '', backspace: true },
      { type: 'edit-key', input: '!', backspace: false },
      { type: 'commit-edit' },
    )

    expect(state.plan.commits[0]!.title).toBe('feat: alph!')
    expect(state.editing).toBeNull()
  })

  it('discards the draft on cancel', () => {
    const state = run(
      start(),
      { type: 'begin-edit' },
      { type: 'edit-key', input: 'XYZ', backspace: false },
      { type: 'cancel-edit' },
    )

    expect(state.plan.commits[0]!.title).toBe('feat: alpha')
  })

  it('rejects an empty title', () => {
    let state = start()
    state = run(state, { type: 'begin-edit' })
    for (let i = 0; i < 20; i++) {
      state = reduce(state, { type: 'edit-key', input: '', backspace: true })
    }
    state = reduce(state, { type: 'commit-edit' })

    expect(state.plan.commits[0]!.title).toBe('feat: alpha')
    expect(state.notice).toMatch(/empty/i)
  })
})

describe('outcome', () => {
  it('approves', () => {
    expect(run(start(), { type: 'approve' }).outcome).toBe('commit')
  })

  it('cancels', () => {
    expect(run(start(), { type: 'cancel' }).outcome).toBe('cancel')
  })

  it('refuses to approve a plan with no files left', () => {
    const base = initialState({
      version: 1,
      commits: [commit('c1', 'empty', [])],
      unassigned: ['a.ts'],
    })

    const state = run(base, { type: 'approve' })
    expect(state.outcome).toBe('pending')
    expect(state.notice).toMatch(/nothing to commit/i)
  })
})

describe('windowAround', () => {
  it('shows everything when the plan fits', () => {
    expect(windowAround(0, 5, 10)).toEqual({ start: 0, end: 5 })
  })

  it('centres on the cursor in a long plan', () => {
    expect(windowAround(10, 30, 6)).toEqual({ start: 7, end: 13 })
  })

  it('clamps at the start', () => {
    expect(windowAround(0, 30, 6)).toEqual({ start: 0, end: 6 })
  })

  it('clamps at the end', () => {
    expect(windowAround(29, 30, 6)).toEqual({ start: 24, end: 30 })
  })
})
