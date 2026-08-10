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
