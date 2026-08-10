import { describe, it, expect, afterEach } from 'vitest'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { stageContent, readAtCommit } from './blob.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

describe('stageContent', () => {
  it('stages content that differs from the working tree', async () => {
    repo = await createTempRepo()
    await repo.write('f.txt', 'original\n')
    await repo.stage()
    await repo.commit('base')

    // Working tree says one thing…
    await writeFile(join(repo.dir, 'f.txt'), 'working tree version\n')
    // …the index is told another.
    await stageContent(repo.git, 'f.txt', 'staged version\n')

    const staged = await repo.git.run(['show', ':f.txt'])
    expect(staged).toBe('staged version\n')

    // And the working tree is untouched — the whole point.
    expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('working tree version\n')
  })

  it('commits exactly the staged content', async () => {
    repo = await createTempRepo()
    await repo.write('f.txt', 'v1\n')
    await repo.stage()
    await repo.commit('base')

    await writeFile(join(repo.dir, 'f.txt'), 'v3\n')
    await stageContent(repo.git, 'f.txt', 'v2\n')
    await repo.git.run(['commit', '-m', 'partial', '--no-verify'])

    expect(await readAtCommit(repo.git, 'HEAD', 'f.txt')).toBe('v2\n')
    expect(await readFile(join(repo.dir, 'f.txt'), 'utf8')).toBe('v3\n')
  })

  it('stages a file that does not exist in HEAD', async () => {
    repo = await createTempRepo()
    await stageContent(repo.git, 'brand-new.txt', 'hello\n')

    expect(await repo.git.run(['show', ':brand-new.txt'])).toBe('hello\n')
  })

  it('preserves the executable bit', async () => {
    repo = await createTempRepo()
    await repo.write('script.sh', '#!/bin/sh\necho one\n')
    await chmod(join(repo.dir, 'script.sh'), 0o755)
    await repo.stage()
    await repo.commit('add script')

    await stageContent(repo.git, 'script.sh', '#!/bin/sh\necho two\n')

    const entry = await repo.git.run(['ls-files', '--stage', '--', 'script.sh'])
    // Dropping this silently would make a committed script non-executable.
    expect(entry.startsWith('100755')).toBe(true)
  })

  it('handles content with no trailing newline', async () => {
    repo = await createTempRepo()
    await stageContent(repo.git, 'f.txt', 'no newline')
    expect(await repo.git.run(['show', ':f.txt'])).toBe('no newline')
  })

  it('handles content far larger than the OS argument limit', async () => {
    repo = await createTempRepo()
    const big = 'x'.repeat(4 * 1024 * 1024)

    await stageContent(repo.git, 'big.txt', big)
    expect((await repo.git.run(['show', ':big.txt'])).length).toBe(big.length)
  })

  it('returns the blob sha', async () => {
    repo = await createTempRepo()
    const sha = await stageContent(repo.git, 'f.txt', 'content\n')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('readAtCommit', () => {
  it('reads a file as of a commit', async () => {
    repo = await createTempRepo()
    await repo.write('f.txt', 'first\n')
    await repo.stage()
    await repo.commit('one')
    await repo.write('f.txt', 'second\n')
    await repo.stage()
    await repo.commit('two')

    expect(await readAtCommit(repo.git, 'HEAD~1', 'f.txt')).toBe('first\n')
    expect(await readAtCommit(repo.git, 'HEAD', 'f.txt')).toBe('second\n')
  })

  it('returns empty for a path that did not exist yet', async () => {
    repo = await createTempRepo()
    expect(await readAtCommit(repo.git, 'HEAD', 'never-existed.txt')).toBe('')
  })
})
