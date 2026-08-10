import { describe, it, expect, afterEach } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildHunkContext } from './hunk-stage.js'
import { executePlan } from './write.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'
import type { CommitPlan } from '../engine/types.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

const lines = (...l: string[]) => l.join('\n') + '\n'

/** A file with two edits far enough apart to become two hunks. */
async function twoHunkFile() {
  const r = await createTempRepo()
  const before = lines(...Array.from({ length: 30 }, (_, i) => `line ${i}`))
  await writeFile(join(r.dir, 'f.txt'), before)
  await r.stage()
  await r.commit('base')

  const after = lines(
    ...Array.from({ length: 30 }, (_, i) =>
      i === 0 ? 'BUGFIX' : i === 25 ? 'RENAME' : `line ${i}`,
    ),
  )
  await writeFile(join(r.dir, 'f.txt'), after)
  return { repo: r, before, after }
}

describe('buildHunkContext', () => {
  it('finds the hunks of a splittable file', async () => {
    const { repo: r } = await twoHunkFile()
    repo = r

    const head = (await r.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(r.git, ['f.txt'], head)

    expect(context.hunksByPath.get('f.txt')).toHaveLength(2)
    expect(context.baseByPath.get('f.txt')).toContain('line 0')
  })

  it('skips files with only one hunk, which cannot be split', async () => {
    repo = await createTempRepo()
    await repo.write('f.txt', lines('a', 'b', 'c'))
    await repo.stage()
    await repo.commit('base')
    await writeFile(join(repo.dir, 'f.txt'), lines('A', 'b', 'c'))

    const head = (await repo.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(repo.git, ['f.txt'], head)

    expect(context.hunksByPath.has('f.txt')).toBe(false)
  })

  it('skips binary files rather than mangling them', async () => {
    repo = await createTempRepo()
    await writeFile(join(repo.dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]))
    await repo.stage()
    await repo.commit('base')
    await writeFile(join(repo.dir, 'blob.bin'), Buffer.from([0, 9, 9, 0, 8]))

    const head = (await repo.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(repo.git, ['blob.bin'], head)

    expect(context.hunksByPath.has('blob.bin')).toBe(false)
  })
})

describe('splitting a file across commits', () => {
  // The headline capability: one file, two unrelated changes, two commits.
  it('puts each hunk in its own commit', async () => {
    const { repo: r, after } = await twoHunkFile()
    repo = r

    const head = (await r.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(r.git, ['f.txt'], head)

    const plan: CommitPlan = {
      version: 1,
      unassigned: [],
      commits: [
        {
          id: 'c1',
          title: 'fix: correct the first line',
          body: null,
          files: ['f.txt'],
          hunks: ['f.txt#0'],
          locked: false,
          warnings: [],
        },
        {
          id: 'c2',
          title: 'refactor: rename near the end',
          body: null,
          files: ['f.txt'],
          hunks: ['f.txt#1'],
          locked: false,
          warnings: [],
        },
      ],
    }

    const result = await executePlan(r.git, plan, { hunkContext: context, verify: false })
    expect(result.rolledBack).toBeUndefined()
    expect(result.shas).toHaveLength(2)

    // First commit contains only the first change.
    const first = await r.git.run(['show', 'HEAD~1:f.txt'])
    expect(first).toContain('BUGFIX')
    expect(first).not.toContain('RENAME')

    // Second commit contains both, so its own diff shows only the second.
    const second = await r.git.run(['show', 'HEAD:f.txt'])
    expect(second).toContain('BUGFIX')
    expect(second).toContain('RENAME')

    // The final commit reproduces the working tree exactly.
    expect(second).toBe(after)
    expect(await readFile(join(r.dir, 'f.txt'), 'utf8')).toBe(after)
  })

  it("each commit's own diff touches only its own hunk", async () => {
    const { repo: r } = await twoHunkFile()
    repo = r

    const head = (await r.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(r.git, ['f.txt'], head)

    await executePlan(
      r.git,
      {
        version: 1,
        unassigned: [],
        commits: [
          { id: 'c1', title: 'one', body: null, files: ['f.txt'], hunks: ['f.txt#0'], locked: false, warnings: [] },
          { id: 'c2', title: 'two', body: null, files: ['f.txt'], hunks: ['f.txt#1'], locked: false, warnings: [] },
        ],
      },
      { hunkContext: context, verify: false },
    )

    const secondDiff = await r.git.run(['show', '--format=', 'HEAD'])
    expect(secondDiff).toContain('RENAME')
    expect(secondDiff).not.toContain('BUGFIX')
  })

  it('leaves the working tree untouched throughout', async () => {
    const { repo: r, after } = await twoHunkFile()
    repo = r

    const head = (await r.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(r.git, ['f.txt'], head)

    await executePlan(
      r.git,
      {
        version: 1,
        unassigned: [],
        commits: [
          { id: 'c1', title: 'one', body: null, files: ['f.txt'], hunks: ['f.txt#0'], locked: false, warnings: [] },
        ],
      },
      { hunkContext: context, verify: false },
    )

    // Only one hunk was committed, so the second remains uncommitted — and the
    // file on disk is still exactly what the user wrote.
    expect(await readFile(join(r.dir, 'f.txt'), 'utf8')).toBe(after)
    expect(await r.git.run(['status', '--porcelain'])).toContain('f.txt')
  })

  it('rolls back cleanly when a later commit fails', async () => {
    const { repo: r, after } = await twoHunkFile()
    repo = r

    const head = (await r.git.run(['rev-parse', 'HEAD'])).trim()
    const context = await buildHunkContext(r.git, ['f.txt'], head)

    const result = await executePlan(
      r.git,
      {
        version: 1,
        unassigned: [],
        commits: [
          { id: 'c1', title: 'one', body: null, files: ['f.txt'], hunks: ['f.txt#0'], locked: false, warnings: [] },
          { id: 'c2', title: 'ghost', body: null, files: ['does-not-exist.txt'], locked: false, warnings: [] },
        ],
      },
      { hunkContext: context, verify: false },
    )

    expect(result.rolledBack).toBeDefined()
    expect((await r.git.run(['rev-parse', 'HEAD'])).trim()).toBe(head)
    expect(await readFile(join(r.dir, 'f.txt'), 'utf8')).toBe(after)
  })
})
