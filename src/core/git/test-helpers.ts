import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createGit, type Git } from './exec.js'

export interface TempRepo {
  dir: string
  git: Git
  /** Write a file, creating parent directories as needed. */
  write(path: string, content: string): Promise<void>
  /** Stage paths (or everything when omitted). */
  stage(...paths: string[]): Promise<void>
  commit(message: string): Promise<void>
  cleanup(): Promise<void>
}

/**
 * Create a real git repository in a temp directory.
 *
 * unbraid's git layer is tested against actual git rather than a mock. Mocking a
 * version control system means testing our idea of git's behaviour, which is
 * exactly the thing most likely to be wrong. Real repos are cheap.
 */
export async function createTempRepo(
  options: { initialCommit?: boolean } = {},
): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'unbraid-test-'))
  const git = createGit(dir)

  await git.run(['init', '-b', 'main'])
  await git.run(['config', 'user.name', 'Test'])
  await git.run(['config', 'user.email', 'test@example.com'])
  await git.run(['config', 'commit.gpgsign', 'false'])

  const write = async (path: string, content: string) => {
    const full = join(dir, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  const stage = async (...paths: string[]) => {
    await git.run(['add', '--', ...(paths.length > 0 ? paths : ['.'])])
  }

  const commit = async (message: string) => {
    await git.run(['commit', '-m', message, '--no-verify'])
  }

  if (options.initialCommit !== false) {
    await write('README.md', '# test\n')
    await stage()
    await commit('initial')
  }

  return {
    dir,
    git,
    write,
    stage,
    commit,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
