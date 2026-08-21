import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveBaseBranch,
  summarizeBranch,
  extractTicket,
  remoteNames,
  stripRemotePrefix,
  BranchError,
} from './branch.js'
import { planCompareUrl } from '../engine/pr-url.js'
import { readRemote } from './remote.js'
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

/**
 * The bug this covers: base detection returns `origin/master`, which is the
 * right ref to diff against and the wrong name to hand GitHub. The compare page
 * opened at `compare/origin/master...branch` and showed nothing.
 */
describe('the base branch a host is told about', () => {
  async function withTrackingBase(): Promise<TempRepo> {
    const r = await createTempRepo()
    await r.git.run([
      'remote',
      'add',
      'origin',
      'git@github.com:acme/widgets.git',
    ])
    // Stand in for a fetched remote-tracking branch, and for the origin/HEAD
    // symref `git clone` leaves behind — both without needing a network.
    await r.git.run(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    await r.git.run([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ])
    await r.git.run(['checkout', '-b', 'fix/thing'])

    await r.write('a.ts', 'export const a = 1\n')
    await r.stage()
    await r.commit('fix: a thing')

    return r
  }

  it('detects the tracking ref, because that is what to compare against', async () => {
    repo = await withTrackingBase()
    expect(await resolveBaseBranch(repo.git)).toBe('origin/main')
  })

  it('lists the repository remotes', async () => {
    repo = await withTrackingBase()
    expect(await remoteNames(repo.git)).toEqual(['origin'])
  })

  it('builds the compare URL from the branch name GitHub has', async () => {
    repo = await withTrackingBase()

    const base = await resolveBaseBranch(repo.git)
    const baseBranch = stripRemotePrefix(base, await remoteNames(repo.git))
    const remote = await readRemote(repo.git)

    const { url } = planCompareUrl({
      remote: remote!,
      target: baseBranch,
      head: 'fix/thing',
      title: 'Fix a thing',
      body: 'body',
    })

    expect(url).toContain('/compare/main...fix/thing')
    expect(url).not.toContain('origin/main...')
  })

  it('still diffs against the tracking ref, not a stale local branch', async () => {
    repo = await withTrackingBase()
    const summary = await summarizeBranch(repo.git, await resolveBaseBranch(repo.git))

    expect(summary.base).toBe('origin/main')
    expect(summary.commits).toHaveLength(1)
  })
})

/**
 * Reported from a real pull request: "17 commits · 60 files · +2624/-69 ·
 * includes 1 merge(s)" for a branch that had touched a fraction of that. The
 * branch had `dev` merged into it, and the stats came from `diff base...HEAD`,
 * which counts everything the merge brought along. The description then
 * described that work as the branch's own.
 */
describe('a branch with another branch merged into it', () => {
  async function withMergedBranch(): Promise<TempRepo> {
    const r = await createTempRepo()

    // Twenty files land on `dev`, none of them this branch's work.
    await r.git.run(['checkout', '-q', '-b', 'dev'])
    for (let i = 0; i < 20; i++) {
      await r.write(`vendor/mod-${i}.ts`, `export const m${i} = ${i}\n`.repeat(20))
    }
    await r.stage()
    await r.commit('feat(vendor): a great deal of somebody else work')

    await r.git.run(['checkout', '-q', 'main'])
    await r.git.run(['checkout', '-q', '-b', 'feature/mine'])
    await r.write('mine.ts', 'export const mine = 1\n')
    await r.stage()
    await r.commit('feat: my own change')

    await r.git.run(['merge', '--no-ff', '-q', '-m', 'Merge dev', 'dev'])

    await r.write('mine-two.ts', 'export const two = 2\n')
    await r.stage()
    await r.commit('feat: my second change')

    return r
  }

  it('counts only the files this branch touched', async () => {
    repo = await withMergedBranch()
    const summary = await summarizeBranch(repo.git, 'main')

    expect(summary.filesChanged).toBe(2)
    expect(summary.insertions).toBe(2)
  })

  it('leaves merged-in files out of the list the model reads', async () => {
    repo = await withMergedBranch()
    const summary = await summarizeBranch(repo.git, 'main')

    expect(summary.diffstat).toContain('mine.ts')
    expect(summary.diffstat).toContain('mine-two.ts')
    expect(summary.diffstat).not.toContain('vendor/')
  })

  // The merge is still reported — just not counted.
  it('still records that a merge happened', async () => {
    repo = await withMergedBranch()
    const summary = await summarizeBranch(repo.git, 'main')

    expect(summary.merges).toHaveLength(1)
    expect(summary.commits.map((c) => c.subject)).not.toContain(
      'feat(vendor): a great deal of somebody else work',
    )
  })

  it('counts normally when nothing was merged in', async () => {
    repo = await createTempRepo()
    await repo.git.run(['checkout', '-q', '-b', 'feature/plain'])
    await repo.write('a.ts', 'export const a = 1\n')
    await repo.stage()
    await repo.commit('feat: a')

    const summary = await summarizeBranch(repo.git, 'main')
    expect(summary.filesChanged).toBe(1)
    expect(summary.insertions).toBe(1)
    expect(summary.merges).toHaveLength(0)
  })
})
