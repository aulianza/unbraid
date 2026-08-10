import { describe, it, expect, afterEach } from 'vitest'
import { preflight } from './preflight.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

describe('preflight', () => {
  it('allows a clean repository on a branch', async () => {
    repo = await createTempRepo()
    const result = await preflight(repo.git)

    expect(result.ok).toBe(true)
    expect(result.operation).toBe('none')
    expect(result.reasons).toEqual([])
  })

  it('refuses to run during a conflicted merge', async () => {
    repo = await createTempRepo()
    await repo.write('conflict.txt', 'base\n')
    await repo.stage()
    await repo.commit('base')

    await repo.git.run(['checkout', '-b', 'other'])
    await repo.write('conflict.txt', 'from other\n')
    await repo.stage()
    await repo.commit('other change')

    await repo.git.run(['checkout', 'main'])
    await repo.write('conflict.txt', 'from main\n')
    await repo.stage()
    await repo.commit('main change')

    // Expected to conflict; we want the repo left mid-merge.
    await repo.git.runRaw(['merge', 'other'])

    const result = await preflight(repo.git)
    expect(result.operation).toBe('merge')
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/merge/i)
  })

  it('refuses on detached HEAD', async () => {
    repo = await createTempRepo()
    const head = (await repo.git.run(['rev-parse', 'HEAD'])).trim()
    await repo.git.run(['checkout', '--detach', head])

    const result = await preflight(repo.git)
    expect(result.detached).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('allows detached HEAD when forced', async () => {
    repo = await createTempRepo()
    const head = (await repo.git.run(['rev-parse', 'HEAD'])).trim()
    await repo.git.run(['checkout', '--detach', head])

    const result = await preflight(repo.git, { force: true })
    expect(result.ok).toBe(true)
  })

  it('reports a non-repository clearly', async () => {
    repo = await createTempRepo()
    const { createGit } = await import('./exec.js')
    const result = await preflight(createGit('/'))

    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/not a git repository/i)
  })
})
