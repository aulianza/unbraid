import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveBaseBranch,
  summarizeBranch,
  extractTicket,
  BranchError,
} from './branch.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

/** A repo with a `main` branch and a feature branch holding two commits. */
async function withFeatureBranch(): Promise<TempRepo> {
  const r = await createTempRepo()
  await r.git.run(['checkout', '-b', 'feature/settings'])

  await r.write('a.ts', 'export const a = 1\n')
  await r.stage()
  await r.commit('feat(settings): add account sheet')

  await r.write('b.ts', 'export const b = 2\n')
  await r.stage()
  await r.commit('feat(settings): add language sheet')

  return r
}

describe('resolveBaseBranch', () => {
  it('finds a conventional base branch', async () => {
    repo = await withFeatureBranch()
    expect(await resolveBaseBranch(repo.git)).toBe('main')
  })

  it('accepts an explicit base', async () => {
    repo = await withFeatureBranch()
    expect(await resolveBaseBranch(repo.git, 'main')).toBe('main')
  })

  it('rejects a base that does not exist', async () => {
    repo = await withFeatureBranch()
    await expect(resolveBaseBranch(repo.git, 'nope')).rejects.toThrow(
      /does not exist/,
    )
  })

  it('explains itself when no base can be found', async () => {
    repo = await createTempRepo()
    await repo.git.run(['branch', '-m', 'main', 'something-unusual'])

    const error = await resolveBaseBranch(repo.git).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BranchError)
    // The actionable part is the hint, not the message.
    expect((error as BranchError).hint).toMatch(/--base/)
  })
})

describe('summarizeBranch', () => {
  it('lists only commits the base does not have, oldest first', async () => {
    repo = await withFeatureBranch()
    const summary = await summarizeBranch(repo.git, 'main')

    expect(summary.branch).toBe('feature/settings')
    expect(summary.commits.map((c) => c.subject)).toEqual([
      'feat(settings): add account sheet',
      'feat(settings): add language sheet',
    ])
    // The base's own "initial" commit must not appear.
    expect(summary.commits).toHaveLength(2)
  })

  it('counts files and lines', async () => {
    repo = await withFeatureBranch()
    const summary = await summarizeBranch(repo.git, 'main')

    expect(summary.filesChanged).toBe(2)
    expect(summary.insertions).toBe(2)
    expect(summary.deletions).toBe(0)
    expect(summary.diffstat).toContain('a.ts')
  })

  it('captures commit bodies', async () => {
    repo = await createTempRepo()
    await repo.git.run(['checkout', '-b', 'feat'])
    await repo.write('x.ts', 'x\n')
    await repo.stage()
    await repo.git.run(['commit', '-m', 'feat: thing', '-m', 'Because of Y.'])

    const summary = await summarizeBranch(repo.git, 'main')
    expect(summary.commits[0]!.body).toBe('Because of Y.')
  })

  // Commits landed on the base after this branch started are not this
  // branch's work, so comparison uses the merge base rather than the base tip.
  it('ignores commits added to the base after the branch started', async () => {
    repo = await withFeatureBranch()

    await repo.git.run(['checkout', 'main'])
    await repo.write('unrelated.ts', 'other work\n')
    await repo.stage()
    await repo.commit('chore: unrelated work on main')
    await repo.git.run(['checkout', 'feature/settings'])

    const summary = await summarizeBranch(repo.git, 'main')

    expect(summary.commits).toHaveLength(2)
    expect(summary.diffstat).not.toContain('unrelated.ts')
  })

  it('refuses when the branch has no new commits', async () => {
    repo = await createTempRepo()
    await repo.git.run(['checkout', '-b', 'empty-branch'])

    await expect(summarizeBranch(repo.git, 'main')).rejects.toThrow(
      /no commits that/,
    )
  })

  it('refuses on a detached HEAD', async () => {
    repo = await withFeatureBranch()
    const head = (await repo.git.run(['rev-parse', 'HEAD'])).trim()
    await repo.git.run(['checkout', '--detach', head])

    await expect(summarizeBranch(repo.git, 'main')).rejects.toThrow(/detached/)
  })
})

describe('extractTicket', () => {
  it.each([
    ['feature/PROJ-123-add-login', '([A-Z]+-\\d+)', 'PROJ-123'],
    ['PROJ-9/fix', '([A-Z]+-\\d+)', 'PROJ-9'],
    ['no-ticket-here', '([A-Z]+-\\d+)', null],
    ['feature/PROJ-1', null, null],
  ])('%s -> %s', (branch, pattern, expected) => {
    expect(extractTicket(branch, pattern)).toBe(expected)
  })

  it('ignores an invalid pattern instead of crashing', () => {
    expect(extractTicket('feature/x', '([unclosed')).toBeNull()
  })
})
