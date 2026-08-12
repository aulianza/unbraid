import { describe, it, expect } from 'vitest'
import { canUndo, describeUndo, type UndoRecord } from './undo.js'
import { validateBranchName } from './history.js'

const record = (extra: Partial<UndoRecord> = {}): UndoRecord => ({
  cwd: '/repo',
  beforeHead: 'aaa',
  afterHead: 'bbb',
  stagedPaths: [],
  commits: 3,
  ...extra,
})

describe('canUndo', () => {
  it('allows undo when HEAD is where the run left it', () => {
    expect(canUndo(record(), 'bbb')).toEqual({ ok: true })
  })

  it('refuses when there is no run to undo', () => {
    const result = canUndo(null, 'bbb')
    expect(result.ok).toBe(false)
  })

  // The rule that makes this safe to offer as a one-click action: resetting
  // past work unbraid did not create is the one thing it must never do.
  it('refuses once the branch has moved', () => {
    const result = canUndo(record(), 'ccc')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/did not create/)
  })

  it('refuses on an unborn branch', () => {
    expect(canUndo(record(), null).ok).toBe(false)
  })
})

describe('describeUndo', () => {
  it('says how many commits and reassures about files', () => {
    const text = describeUndo(record({ commits: 5 }))
    expect(text).toContain('5 commits')
    expect(text).toMatch(/files are not touched/)
  })

  it('mentions restoring staging only when there was some', () => {
    expect(describeUndo(record({ stagedPaths: ['a.ts', 'b.ts'] }))).toMatch(
      /restore the 2 files you had staged/,
    )
    expect(describeUndo(record({ stagedPaths: [] }))).not.toMatch(/staged/)
  })

  it('uses the singular for one commit', () => {
    const text = describeUndo(record({ commits: 1 }))
    expect(text).toContain('1 commit')
    expect(text).not.toContain('1 commits')
  })
})

describe('validateBranchName', () => {
  it.each([['feature/x'], ['fix-123'], ['release/2.0']])('accepts %s', (name) => {
    expect(validateBranchName(name)).toBeNull()
  })

  // Checked before calling git so the message names the problem, instead of
  // surfacing git's own wording about ref format rules.
  it.each([
    ['', 'empty'],
    ['  ', 'whitespace only'],
    ['my branch', 'contains a space'],
    ['-leading', 'leading dash'],
    ['trailing.', 'trailing dot'],
    ['a..b', 'double dot'],
    ['a~b', 'tilde'],
    ['a^b', 'caret'],
    ['a:b', 'colon'],
    ['a?b', 'question mark'],
    ['a[b', 'bracket'],
    ['thing.lock', 'lock suffix'],
  ])('rejects %j (%s)', (name) => {
    expect(validateBranchName(name)).not.toBeNull()
  })
})
