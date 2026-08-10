import { describe, it, expect, afterEach } from 'vitest'
import { executePlan, push } from './write.js'
import { takeSnapshot, restoreSnapshot } from './snapshot.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'
import type { CommitPlan } from '../engine/types.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

const plan = (commits: CommitPlan['commits']): CommitPlan => ({
  version: 1,
  commits,
  unassigned: [],
})

const commit = (
  id: string,
  title: string,
  files: string[],
): CommitPlan['commits'][number] => ({
  id,
  title,
  body: null,
  files,
  locked: false,
  warnings: [],
})

const log = async () =>
  (await repo.git.run(['log', '--format=%s'])).trim().split('\n')

describe('executePlan', () => {
  it('creates one commit per group, in order', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'a\n')
    await repo.write('b.ts', 'b\n')

    const result = await executePlan(
      repo.git,
      plan([commit('c1', 'feat: add a', ['a.ts']), commit('c2', 'feat: add b', ['b.ts'])]),
    )

    expect(result.rolledBack).toBeUndefined()
    expect(result.shas).toHaveLength(2)
    expect(await log()).toEqual(['feat: add b', 'feat: add a', 'initial'])
  })

  it('puts only the listed files in each commit', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'a\n')
    await repo.write('b.ts', 'b\n')

    await executePlan(
      repo.git,
      plan([commit('c1', 'feat: a', ['a.ts']), commit('c2', 'feat: b', ['b.ts'])]),
    )

    const first = await repo.git.run(['show', '--name-only', '--format=', 'HEAD~1'])
    expect(first.trim()).toBe('a.ts')
  })

  it('writes the body as a separate paragraph', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'a\n')

    await executePlan(
      repo.git,
      plan([{ ...commit('c1', 'feat: a', ['a.ts']), body: 'Why this matters.' }]),
    )

    const message = await repo.git.run(['log', '-1', '--format=%B'])
    expect(message).toContain('feat: a\n\nWhy this matters.')
  })

  it('rolls back every commit when one fails', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'a\n')
    const before = (await repo.git.run(['rev-parse', 'HEAD'])).trim()

    const result = await executePlan(
      repo.git,
      plan([
        commit('c1', 'feat: a', ['a.ts']),
        commit('c2', 'feat: ghost', ['does-not-exist.ts']),
      ]),
    )

    expect(result.rolledBack).toBeDefined()
    expect(result.shas).toEqual([])
    expect((await repo.git.run(['rev-parse', 'HEAD'])).trim()).toBe(before)
    expect(await log()).toEqual(['initial'])
  })

  it('leaves file contents untouched after a rollback', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'important work\n')

    await executePlan(
      repo.git,
      plan([commit('c1', 'feat: a', ['a.ts']), commit('c2', 'ghost', ['nope.ts'])]),
    )

    const state = await repo.git.run(['status', '--porcelain'])
    expect(state).toContain('a.ts')
  })

  it('reports progress for each commit', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'a\n')
    await repo.write('b.ts', 'b\n')

    const seen: number[] = []
    await executePlan(
      repo.git,
      plan([commit('c1', 'feat: a', ['a.ts']), commit('c2', 'feat: b', ['b.ts'])]),
      { onCommit: (_id, _sha, index, total) => seen.push(index / total) },
    )

    expect(seen).toEqual([0.5, 1])
  })
})

describe('snapshot', () => {
  it('restores the original staging after a rollback', async () => {
    repo = await createTempRepo()
    await repo.write('staged.ts', 's\n')
    await repo.write('loose.ts', 'l\n')
    await repo.stage('staged.ts')

    const snapshot = await takeSnapshot(repo.git)
    expect(snapshot.stagedPaths).toEqual(['staged.ts'])

    await repo.stage()
    await repo.commit('interfering commit')
    await restoreSnapshot(repo.git, snapshot)

    const staged = (await repo.git.run(['diff', '--name-only', '--cached'])).trim()
    expect(staged).toBe('staged.ts')
    expect((await repo.git.run(['rev-parse', 'HEAD'])).trim()).toBe(snapshot.head)
  })

  it('handles an unborn branch', async () => {
    repo = await createTempRepo({ initialCommit: false })
    await repo.write('first.ts', 'x\n')

    const snapshot = await takeSnapshot(repo.git)
    expect(snapshot.head).toBeNull()

    await repo.stage()
    await repo.commit('first commit')
    await restoreSnapshot(repo.git, snapshot)

    const head = await repo.git.runRaw(['rev-parse', 'HEAD'])
    expect(head.code).not.toBe(0) // back to unborn
  })
})

describe('push', () => {
  it('surfaces a clear error when there is no remote', async () => {
    repo = await createTempRepo()
    await expect(push(repo.git)).rejects.toThrow(/origin/)
  })
})
