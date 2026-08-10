import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { Review } from './App.js'
import type { CommitPlan, WorkingTreeState } from '../../core/engine/types.js'

const tree: WorkingTreeState = {
  root: '/repo',
  head: 'abc',
  branch: 'main',
  files: [
    {
      path: 'a.ts',
      status: 'modified',
      staged: false,
      insertions: 1,
      deletions: 0,
      binary: false,
    },
    {
      path: 'landing/',
      status: 'untracked',
      staged: false,
      insertions: 0,
      deletions: 0,
      binary: false,
      collapsed: true,
      fileCount: 374,
    },
  ],
  operation: 'none',
  detached: false,
}

const plan: CommitPlan = {
  version: 1,
  commits: [
    {
      id: 'c1',
      title: 'feat: add alpha',
      body: null,
      files: ['a.ts'],
      locked: false,
      warnings: [],
    },
    {
      id: 'c2',
      title: 'feat: add landing site',
      body: null,
      files: ['landing/'],
      locked: true,
      warnings: ['mixes concerns'],
    },
  ],
  unassigned: ['orphan.ts'],
}

const draw = () => {
  const { lastFrame } = render(
    <Review plan={plan} state={tree} onDone={() => {}} />,
  )
  return lastFrame() ?? ''
}

describe('Review', () => {
  it('lists every commit title', () => {
    const frame = draw()
    expect(frame).toContain('feat: add alpha')
    expect(frame).toContain('feat: add landing site')
  })

  it('marks the selected row', () => {
    expect(draw()).toContain('▸')
  })

  it('shows the real file count behind a collapsed directory', () => {
    // The whole point of the earlier fix: not "1 file".
    expect(draw()).toContain('374 files')
  })

  it('flags pre-staged commits', () => {
    expect(draw()).toContain('pre-staged')
  })

  it('surfaces warnings', () => {
    expect(draw()).toContain('mixes concerns')
  })

  it('reports unassigned files', () => {
    expect(draw()).toContain('1 unassigned file(s)')
  })

  it('shows the key bindings', () => {
    const frame = draw()
    expect(frame).toContain('c commit')
    expect(frame).toContain('q quit')
  })
})
