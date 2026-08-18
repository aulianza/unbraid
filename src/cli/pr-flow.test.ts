import { describe, it, expect, afterEach } from 'vitest'
import { decidePush, ensurePushed } from './pr-flow.js'
import { browserCommand, clipboardCommand, openUrl, copyToClipboard } from './open-url.js'
import { upstreamStatus, listBranches } from '../core/git/branch.js'
import { createTempRepo, type TempRepo } from '../core/git/test-helpers.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

/** A repo with a real (bare) remote, so upstream tracking behaves normally. */
async function repoWithRemote(): Promise<TempRepo> {
  const r = await createTempRepo()
  const bare = `${r.dir}-remote.git`
  await r.git.run(['init', '--bare', '-q', bare])
  await r.git.run(['remote', 'add', 'origin', bare])
  await r.git.run(['push', '-q', '--set-upstream', 'origin', 'main'])
  return r
}

describe('decidePush', () => {
  it('requires a push when there is no upstream', () => {
    const decision = decidePush({ upstream: null, ahead: 0 }, 'feat/x')

    expect(decision.needed).toBe(true)
    expect(decision.setUpstream).toBe(true)
    expect(decision.reason).toMatch(/cannot see/)
  })

  // The dangerous case: this one looks like success and produces a pull
  // request quietly missing the newest commits.
  it('requires a push when local commits are unpushed', () => {
    const decision = decidePush({ upstream: 'origin/feat/x', ahead: 3 }, 'feat/x')

    expect(decision.needed).toBe(true)
    expect(decision.setUpstream).toBe(false)
    expect(decision.reason).toMatch(/3 commits/)
  })

  it('uses the singular for one commit', () => {
    expect(decidePush({ upstream: 'origin/x', ahead: 1 }, 'x').reason).toMatch(/1 commit that/)
  })

  it('requires nothing when the branch is up to date', () => {
    expect(decidePush({ upstream: 'origin/x', ahead: 0 }, 'x').needed).toBe(false)
  })
})

describe('upstreamStatus', () => {
  it('reports no upstream for a fresh branch', async () => {
    repo = await repoWithRemote()
    await repo.git.run(['checkout', '-q', '-b', 'feat/x'])

    expect(await upstreamStatus(repo.git)).toEqual({ upstream: null, ahead: 0, behind: 0 })
  })

  it('counts unpushed commits', async () => {
    repo = await repoWithRemote()
    await repo.write('a.ts', 'a\n')
    await repo.stage()
    await repo.commit('feat: a')
    await repo.write('b.ts', 'b\n')
    await repo.stage()
    await repo.commit('feat: b')

    const status = await upstreamStatus(repo.git)
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(0)
  })

  it('reports nothing outstanding right after a push', async () => {
    repo = await repoWithRemote()
    await repo.write('a.ts', 'a\n')
    await repo.stage()
    await repo.commit('feat: a')
    await repo.git.run(['push', '-q'])

    expect((await upstreamStatus(repo.git)).ahead).toBe(0)
  })
})

describe('ensurePushed', () => {
  it('pushes after confirmation and sets upstream', async () => {
    repo = await repoWithRemote()
    await repo.git.run(['checkout', '-q', '-b', 'feat/x'])
    await repo.write('a.ts', 'a\n')
    await repo.stage()
    await repo.commit('feat: a')

    let pushed = false
    const ok = await ensurePushed({
      git: repo.git,
      branch: 'feat/x',
      remote: 'origin',
      confirm: async () => true,
      onPushed: () => (pushed = true),
    })

    expect(ok).toBe(true)
    expect(pushed).toBe(true)
    expect((await upstreamStatus(repo.git)).upstream).toBe('origin/feat/x')
  })

  it('stops without pushing when declined', async () => {
    repo = await repoWithRemote()
    await repo.git.run(['checkout', '-q', '-b', 'feat/x'])
    await repo.write('a.ts', 'a\n')
    await repo.stage()
    await repo.commit('feat: a')

    const ok = await ensurePushed({
      git: repo.git,
      branch: 'feat/x',
      remote: 'origin',
      confirm: async () => false,
    })

    expect(ok).toBe(false)
    expect((await upstreamStatus(repo.git)).upstream).toBeNull()
  })

  it('does not prompt when nothing needs pushing', async () => {
    repo = await repoWithRemote()
    let asked = false

    const ok = await ensurePushed({
      git: repo.git,
      branch: 'main',
      remote: 'origin',
      confirm: async () => {
        asked = true
        return true
      },
    })

    expect(ok).toBe(true)
    expect(asked).toBe(false)
  })
})

describe('listBranches', () => {
  it('lists local branches for suggesting a target', async () => {
    repo = await createTempRepo()
    await repo.git.run(['branch', 'develop'])
    await repo.git.run(['branch', 'release/2.0'])

    const branches = await listBranches(repo.git)
    expect(branches).toContain('main')
    expect(branches).toContain('develop')
    expect(branches).toContain('release/2.0')
  })
})

// `unbraid pr --yes` silently did nothing: the program and the subcommand both
// declare `-y, --yes`, and by default commander binds a program-level option
// wherever it appears — including after a subcommand name. The flag parsed
// successfully onto the wrong command, so nothing errored and nothing worked.
describe('commander option scoping', () => {
  const build = async (positional: boolean) => {
    const { Command } = await import('commander')
    const program = new Command()
    if (positional) program.enablePositionalOptions()

    let seen: Record<string, unknown> = {}
    program.option('-y, --yes', 'program level')
    program
      .command('pr')
      .option('--web', '')
      .option('-y, --yes', 'subcommand level')
      .action((flags: Record<string, unknown>) => {
        seen = flags
      })

    await program.parseAsync(['node', 'unbraid', 'pr', '--web', '--yes'])
    return seen
  }

  it('loses the subcommand flag without positional options', async () => {
    expect(await build(false)).not.toHaveProperty('yes')
  })

  it('keeps it once positional options are enabled', async () => {
    expect(await build(true)).toMatchObject({ web: true, yes: true })
  })
})

// `-V` is commander's default and nobody types it. The flags string is the
// only thing that moves it to `-v`, and a later option claiming `-v` would take
// it back silently.
describe('version flag', () => {
  const parse = async (argv: string[]) => {
    const { Command } = await import('commander')
    const program = new Command()
    let printed = ''

    program
      .name('unbraid')
      .version('9.9.9', '-v, --version', 'print the version and exit')
      .exitOverride()
      .configureOutput({ writeOut: (str) => (printed += str) })

    try {
      await program.parseAsync(['node', 'unbraid', ...argv])
    } catch {
      // commander throws to stop the process after printing the version.
    }
    return printed.trim()
  }

  it('prints the version for -v', async () => {
    expect(await parse(['-v'])).toBe('9.9.9')
  })

  it('prints the version for --version', async () => {
    expect(await parse(['--version'])).toBe('9.9.9')
  })

  it('no longer answers to commander default -V', async () => {
    expect(await parse(['-V'])).toBe('')
  })
})

describe('browserCommand', () => {
  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
    ['win32', 'cmd'],
  ])('%s uses %s', (platform, cmd) => {
    expect(browserCommand('https://example.com', platform).cmd).toBe(cmd)
  })

  // Without the empty title argument, `start` treats the quoted URL as a window
  // title and opens nothing.
  it('passes an empty title argument on Windows', () => {
    const command = browserCommand('https://example.com', 'win32')
    expect(command.args).toEqual(['/c', 'start', '', 'https://example.com'])
  })

  it('never runs anything by itself', async () => {
    const calls: string[] = []
    await openUrl('https://example.com', 'darwin', async ({ cmd }) => {
      calls.push(cmd)
    })
    expect(calls).toEqual(['open'])
  })
})

describe('copyToClipboard', () => {
  it.each([
    ['darwin', 'pbcopy'],
    ['win32', 'clip'],
    ['linux', 'xclip'],
  ])('%s uses %s', (platform, cmd) => {
    expect(clipboardCommand(platform)!.cmd).toBe(cmd)
  })

  it('passes the text on stdin', async () => {
    let received: string | undefined
    await copyToClipboard('hello', 'darwin', async (_command, input) => {
      received = input
    })
    expect(received).toBe('hello')
  })

  // A missing clipboard tool is an inconvenience, not a reason to fail the
  // whole command — the caller can print the text instead.
  it('reports failure instead of throwing', async () => {
    const ok = await copyToClipboard('hello', 'linux', async () => {
      throw new Error('xclip: not found')
    })
    expect(ok).toBe(false)
  })
})
