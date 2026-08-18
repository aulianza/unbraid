import { describe, it, expect, afterEach } from 'vitest'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { stageInBatches } from './snapshot.js'
import { GitError } from './exec.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

const stagedStatus = async (path: string): Promise<string> => {
  const out = await repo.git.run(['status', '--porcelain', '--', path])
  return out.slice(0, 2)
}

describe('stageInBatches', () => {
  it('stages an edit', async () => {
    repo = await createTempRepo()
    await repo.write('a.ts', 'export const a = 1\n')
    await repo.stage()
    await repo.commit('feat: add a')

    await repo.write('a.ts', 'export const a = 2\n')
    await stageInBatches(repo.git, ['a.ts'])

    expect(await stagedStatus('a.ts')).toBe('M ')
  })

  it('stages a file deleted from disk as a deletion', async () => {
    repo = await createTempRepo()
    await repo.write('gone.ts', 'export const gone = 1\n')
    await repo.stage()
    await repo.commit('feat: add gone')

    await repo.git.run(['rm', '--quiet', '--', 'gone.ts'])
    await repo.git.runRaw(['reset', '--quiet', '--', '.'])
    await stageInBatches(repo.git, ['gone.ts'])

    expect(await stagedStatus('gone.ts')).toBe('D ')
  })

  /**
   * Adding a previously-committed directory to .gitignore is the ordinary way
   * to reach this: `git rm -r --cached .claude` plus a .gitignore entry. The
   * file is still on disk, so `git add -A` sees an ignored file and refuses —
   * "The following paths are ignored by one of your .gitignore files" — which
   * failed the whole run rather than recording the removal the index already
   * held.
   */
  it('records a path that left the index but stayed on disk', async () => {
    repo = await createTempRepo()
    await repo.write('.claude/config.json', '{}\n')
    await repo.stage()
    await repo.commit('chore: add tooling')

    await repo.write('.gitignore', '.claude/\n')
    await repo.git.run(['rm', '-r', '--cached', '--quiet', '--', '.claude'])
    await repo.git.runRaw(['reset', '--quiet', '--', '.'])

    await stageInBatches(repo.git, ['.claude/config.json'])
    await repo.git.run(['commit', '--quiet', '-m', 'chore: stop tracking .claude'])

    // Gone from git...
    const tracked = await repo.git.run(['ls-files', '--', '.claude'])
    expect(tracked.trim()).toBe('')

    // ...and still on disk, which is the whole point of --cached.
    await expect(access(join(repo.dir, '.claude/config.json'))).resolves.toBeUndefined()
  })

  it('keeps staging the other paths in the batch', async () => {
    repo = await createTempRepo()
    await repo.write('.claude/config.json', '{}\n')
    await repo.write('keep.ts', 'export const keep = 1\n')
    await repo.stage()
    await repo.commit('chore: add both')

    await repo.write('.gitignore', '.claude/\n')
    await repo.write('keep.ts', 'export const keep = 2\n')
    await repo.git.run(['rm', '-r', '--cached', '--quiet', '--', '.claude'])
    await repo.git.runRaw(['reset', '--quiet', '--', '.'])

    // One ignored path in the batch used to fail all of them, since git stages
    // nothing when it refuses any argument.
    await stageInBatches(repo.git, ['.claude/config.json', 'keep.ts'])

    expect(await stagedStatus('keep.ts')).toBe('M ')
    expect(await repo.git.run(['ls-files', '--', '.claude'])).toBe('')
  })

  it('still reports a genuine failure', async () => {
    repo = await createTempRepo()
    await expect(
      stageInBatches(repo.git, ['../outside-the-repo.ts']),
    ).rejects.toBeInstanceOf(GitError)
  })
})
