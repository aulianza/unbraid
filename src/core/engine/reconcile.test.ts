import { describe, it, expect } from 'vitest'
import { reconcile } from './reconcile.js'

/**
 * The reconciler is unbraid's safety net. Language models hallucinate paths,
 * assign the same file twice, and quietly forget files. Every test here encodes
 * a failure we assume the model WILL produce.
 */
describe('reconcile', () => {
  it('keeps a well-formed grouping intact', () => {
    const plan = reconcile({
      groups: [
        { title: 'feat: auth', files: ['a.ts', 'b.ts'] },
        { title: 'docs: readme', files: ['README.md'] },
      ],
      realFiles: ['a.ts', 'b.ts', 'README.md'],
    })

    expect(plan.version).toBe(1)
    expect(plan.commits).toHaveLength(2)
    expect(plan.commits[0]!.files).toEqual(['a.ts', 'b.ts'])
    expect(plan.commits[1]!.files).toEqual(['README.md'])
    expect(plan.unassigned).toEqual([])
  })

  it('drops hallucinated paths that do not exist in the working tree', () => {
    const plan = reconcile({
      groups: [{ title: 'feat: auth', files: ['a.ts', 'imaginary.ts'] }],
      realFiles: ['a.ts'],
    })

    expect(plan.commits[0]!.files).toEqual(['a.ts'])
    expect(plan.commits[0]!.warnings.join(' ')).toContain('imaginary.ts')
  })

  it('keeps a duplicated file in the first group only', () => {
    const plan = reconcile({
      groups: [
        { title: 'feat: auth', files: ['a.ts', 'shared.ts'] },
        { title: 'fix: api', files: ['shared.ts', 'b.ts'] },
      ],
      realFiles: ['a.ts', 'b.ts', 'shared.ts'],
    })

    expect(plan.commits[0]!.files).toEqual(['a.ts', 'shared.ts'])
    expect(plan.commits[1]!.files).toEqual(['b.ts'])
    expect(plan.unassigned).toEqual([])
  })

  it('never loses a file the model forgot to place', () => {
    const plan = reconcile({
      groups: [{ title: 'feat: auth', files: ['a.ts'] }],
      realFiles: ['a.ts', 'forgotten.ts', 'also-forgotten.ts'],
    })

    expect(plan.unassigned).toEqual(['forgotten.ts', 'also-forgotten.ts'])
  })

  it('prunes groups left empty after validation', () => {
    const plan = reconcile({
      groups: [
        { title: 'feat: auth', files: ['a.ts'] },
        { title: 'ghost commit', files: ['nope.ts'] },
      ],
      realFiles: ['a.ts'],
    })

    expect(plan.commits).toHaveLength(1)
    expect(plan.commits[0]!.title).toBe('feat: auth')
  })

  it('places locked groups first and marks them locked', () => {
    const plan = reconcile({
      groups: [{ title: 'feat: auth', files: ['a.ts'] }],
      realFiles: ['a.ts', 'staged.ts'],
      locked: [{ title: 'chore: pre-staged changes', files: ['staged.ts'] }],
    })

    expect(plan.commits[0]!.locked).toBe(true)
    expect(plan.commits[0]!.files).toEqual(['staged.ts'])
    expect(plan.commits[1]!.locked).toBe(false)
    expect(plan.unassigned).toEqual([])
  })

  it('removes locked files from model groups that wrongly claimed them', () => {
    const plan = reconcile({
      groups: [{ title: 'feat: auth', files: ['a.ts', 'staged.ts'] }],
      realFiles: ['a.ts', 'staged.ts'],
      locked: [{ title: 'chore: pre-staged', files: ['staged.ts'] }],
    })

    const modelGroup = plan.commits.find((c) => !c.locked)!
    expect(modelGroup.files).toEqual(['a.ts'])
  })

  it('assigns stable, unique ids', () => {
    const plan = reconcile({
      groups: [
        { title: 'one', files: ['a.ts'] },
        { title: 'two', files: ['b.ts'] },
      ],
      realFiles: ['a.ts', 'b.ts'],
    })

    const ids = plan.commits.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns everything as unassigned when the model returns nothing', () => {
    const plan = reconcile({ groups: [], realFiles: ['a.ts', 'b.ts'] })

    expect(plan.commits).toEqual([])
    expect(plan.unassigned).toEqual(['a.ts', 'b.ts'])
  })

  describe('hunk splitting', () => {
    it('lets two commits share a file when each takes different hunks', () => {
      const plan = reconcile({
        groups: [
          { title: 'fix: bug', files: ['a.ts'], hunks: ['a.ts#0'] },
          { title: 'refactor: rename', files: ['a.ts'], hunks: ['a.ts#1'] },
        ],
        realFiles: ['a.ts'],
        availableHunks: ['a.ts#0', 'a.ts#1'],
      })

      expect(plan.commits).toHaveLength(2)
      expect(plan.commits[0]!.hunks).toEqual(['a.ts#0'])
      expect(plan.commits[1]!.hunks).toEqual(['a.ts#1'])
      // Both legitimately list the file.
      expect(plan.commits[0]!.files).toEqual(['a.ts'])
      expect(plan.commits[1]!.files).toEqual(['a.ts'])
      expect(plan.unassigned).toEqual([])
    })

    it('drops hunk ids that do not exist', () => {
      const plan = reconcile({
        groups: [{ title: 'fix', files: ['a.ts'], hunks: ['a.ts#0', 'a.ts#99'] }],
        realFiles: ['a.ts'],
        availableHunks: ['a.ts#0'],
      })

      expect(plan.commits[0]!.hunks).toEqual(['a.ts#0'])
    })

    it('keeps a duplicated hunk in the first commit only', () => {
      const plan = reconcile({
        groups: [
          { title: 'one', files: ['a.ts'], hunks: ['a.ts#0'] },
          { title: 'two', files: ['a.ts'], hunks: ['a.ts#0', 'a.ts#1'] },
        ],
        realFiles: ['a.ts'],
        availableHunks: ['a.ts#0', 'a.ts#1'],
      })

      expect(plan.commits[0]!.hunks).toEqual(['a.ts#0'])
      expect(plan.commits[1]!.hunks).toEqual(['a.ts#1'])
    })

    // Found by running against a real repository. The model decided none of
    // the files needed splitting — correct — and every hunk was then reported
    // as "unassigned", producing a warning per hunk on an ordinary plan.
    it('says nothing when a file is simply taken whole', () => {
      const plan = reconcile({
        groups: [{ title: 'feat: one coherent change', files: ['a.ts', 'b.ts'], hunks: [] }],
        realFiles: ['a.ts', 'b.ts'],
        availableHunks: ['a.ts#0', 'a.ts#1', 'b.ts#0'],
      })

      expect(plan.commits[0]!.warnings).toEqual([])
      expect(plan.commits[0]!.hunks).toBeUndefined()
      expect(plan.commits[0]!.files).toEqual(['a.ts', 'b.ts'])
      expect(plan.unassigned).toEqual([])
    })

    it('warns only about the file that was actually split', () => {
      const plan = reconcile({
        groups: [
          // a.ts is split and one of its hunks is forgotten; b.ts is taken whole.
          { title: 'fix', files: ['a.ts', 'b.ts'], hunks: ['a.ts#0'] },
        ],
        realFiles: ['a.ts', 'b.ts'],
        availableHunks: ['a.ts#0', 'a.ts#1', 'b.ts#0'],
      })

      const warnings = plan.commits[0]!.warnings.join(' ')
      expect(warnings).toContain('a.ts#1')
      expect(warnings).not.toContain('b.ts#0')
      expect(plan.commits[0]!.hunks).toEqual(['a.ts#0', 'a.ts#1'])
    })

    // Losing a hunk would mean the final commit does not reproduce the
    // working tree — the same class of bug as losing a file.
    it('never leaves a hunk unassigned', () => {
      const plan = reconcile({
        groups: [{ title: 'partial', files: ['a.ts'], hunks: ['a.ts#0'] }],
        realFiles: ['a.ts'],
        availableHunks: ['a.ts#0', 'a.ts#1', 'a.ts#2'],
      })

      const assigned = plan.commits.flatMap((c) => c.hunks ?? [])
      expect(assigned.sort()).toEqual(['a.ts#0', 'a.ts#1', 'a.ts#2'])
      expect(plan.commits[0]!.warnings.join(' ')).toContain('a.ts#1')
    })

    it('adds a file named only through its hunks', () => {
      const plan = reconcile({
        groups: [{ title: 'fix', files: [], hunks: ['a.ts#0'] }],
        realFiles: ['a.ts'],
        availableHunks: ['a.ts#0'],
      })

      expect(plan.commits[0]!.files).toEqual(['a.ts'])
    })

    it('does not report a split file as unassigned', () => {
      const plan = reconcile({
        groups: [{ title: 'fix', files: ['a.ts'], hunks: ['a.ts#0', 'a.ts#1'] }],
        realFiles: ['a.ts', 'b.ts'],
        availableHunks: ['a.ts#0', 'a.ts#1'],
      })

      expect(plan.unassigned).toEqual(['b.ts'])
    })

    it('omits the hunks field entirely when nothing is split', () => {
      const plan = reconcile({
        groups: [{ title: 'whole file', files: ['a.ts'] }],
        realFiles: ['a.ts'],
      })

      expect(plan.commits[0]!.hunks).toBeUndefined()
    })

    it('handles a path containing a hash character', () => {
      const plan = reconcile({
        groups: [{ title: 'odd', files: ['weird#name.ts'], hunks: ['weird#name.ts#0'] }],
        realFiles: ['weird#name.ts'],
        availableHunks: ['weird#name.ts#0'],
      })

      expect(plan.commits[0]!.files).toEqual(['weird#name.ts'])
      expect(plan.unassigned).toEqual([])
    })
  })

  it('preserves model-supplied warnings alongside its own', () => {
    const plan = reconcile({
      groups: [
        {
          title: 'fix: api',
          files: ['a.ts', 'ghost.ts'],
          warnings: ['a.ts also contains an unrelated rename'],
        },
      ],
      realFiles: ['a.ts'],
    })

    expect(plan.commits[0]!.warnings).toHaveLength(2)
    expect(plan.commits[0]!.warnings[0]).toContain('unrelated rename')
  })
})
