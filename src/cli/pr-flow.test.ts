import { describe, it, expect, afterEach } from 'vitest'
import { decidePush, ensurePushed } from './pr-flow.js'
import { browserCommand, clipboardCommand, openUrl, copyToClipboard } from './open-url.js'
import {
  upstreamStatus,
  listBranches,
  planPush,
  type PushPlan,
} from '../core/git/branch.js'
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

const plan = (over: Partial<PushPlan> = {}): PushPlan => ({
  ref: 'origin/feat/x',
  exists: true,
  ahead: 0,
  trackingElsewhere: null,
  ...over,
})

/**
 * The reported case, end to end against a real remote.
 *
 * A feature branch was created from `dev` and kept `origin/dev` as its
 * upstream. unbraid read that upstream and told the user it was "Pushing 16
 * commits to origin/dev" — a sentence that reads like it is about to write to a
 * shared branch. It was not: `git push <remote> <branch>` names the branch, so
 * the commits were only ever going to `origin/games/word-scramble`.
 */
describe('planPush against a branch tracking somewhere else', () => {
  async function branchTrackingDev(): Promise<TempRepo> {
    const r = await repoWithRemote()

    await r.git.run(['checkout', '-q', '-b', 'dev'])
    await r.write('dev.ts', 'export const dev = 1\n')
    await r.stage()
    await r.commit('chore: dev')
    await r.git.run(['push', '-q', '--set-upstream', 'origin', 'dev'])

    await r.git.run(['checkout', '-q', '-b', 'games/word-scramble'])
    await r.git.run(['branch', '--set-upstream-to=origin/dev', 'games/word-scramble'])
    await r.write('scramble.ts', 'export const scramble = 1\n')
    await r.stage()
    await r.commit('feat: scramble')

    return r
  }

  it("reports the branch's own ref as the target", async () => {
    repo = await branchTrackingDev()
    const plan = await planPush(repo.git, 'origin', 'games/word-scramble')

    expect(plan.ref).toBe('origin/games/word-scramble')
    expect(plan.ref).not.toContain('dev')
  })

  it('knows the branch is not on the remote, whatever it tracks', async () => {
    repo = await branchTrackingDev()
    const plan = await planPush(repo.git, 'origin', 'games/word-scramble')

    // git rev-parse @{u} answers origin/dev here, which is why this used to
    // read as "already pushed".
    expect(plan.exists).toBe(false)
    expect(plan.trackingElsewhere).toBe('origin/dev')
  })

  it('counts against the branch, once it is on the remote', async () => {
    repo = await branchTrackingDev()
    await repo.git.run(['push', '-q', 'origin', 'games/word-scramble'])

    await repo.write('more.ts', 'export const more = 1\n')
    await repo.stage()
    await repo.commit('feat: more')

    const plan = await planPush(repo.git, 'origin', 'games/word-scramble')
    expect(plan.exists).toBe(true)
    expect(plan.ahead).toBe(1)
  })

  // The whole point: the shared branch is untouched.
  it('leaves the tracked branch alone when the push happens', async () => {
    repo = await branchTrackingDev()
    const devBefore = (await repo.git.run(['rev-parse', 'origin/dev'])).trim()

    await ensurePushed({
      git: repo.git,
      branch: 'games/word-scramble',
      remote: 'origin',
      confirm: async () => true,
    })

    await repo.git.run(['fetch', '-q', 'origin'])
    const devAfter = (await repo.git.run(['rev-parse', 'origin/dev'])).trim()

    expect(devAfter).toBe(devBefore)
    expect(
      (await repo.git.runRaw(['rev-parse', '--verify', 'refs/remotes/origin/games/word-scramble']))
        .code,
    ).toBe(0)
  })

  it('reports no mismatch for an ordinary branch', async () => {
    repo = await repoWithRemote()
    const plan = await planPush(repo.git, 'origin', 'main')

    expect(plan.exists).toBe(true)
    expect(plan.trackingElsewhere).toBeNull()
  })
})

describe('decidePush', () => {
  it('requires a push when the branch is not on the remote', () => {
    const decision = decidePush(plan({ exists: false }), 'feat/x')

    expect(decision.needed).toBe(true)
    expect(decision.setUpstream).toBe(true)
    expect(decision.reason).toMatch(/cannot see/)
  })

  // The dangerous case: this one looks like success and produces a pull
  // request quietly missing the newest commits.
  it('requires a push when local commits are unpushed', () => {
    const decision = decidePush(plan({ ahead: 3 }), 'feat/x')

    expect(decision.needed).toBe(true)
    expect(decision.setUpstream).toBe(false)
    expect(decision.reason).toMatch(/3 commits/)
  })

  it('uses the singular for one commit', () => {
    expect(decidePush(plan({ ahead: 1 }), 'x').reason).toMatch(/1 commit that/)
  })

  it('requires nothing when the branch is up to date', () => {
    expect(decidePush(plan(), 'x').needed).toBe(false)
  })

  /**
   * A branch created from `dev` keeps `origin/dev` as its upstream while
   * pushing to its own name. Judged on the upstream, a branch that had never
   * been pushed looked pushed, and its commit count was measured against a
   * branch it was not going to touch.
   */
  it('ignores an upstream pointing at another branch', () => {
    const decision = decidePush(
      plan({ exists: false, trackingElsewhere: 'origin/dev' }),
      'games/word-scramble',
    )

    expect(decision.needed).toBe(true)
    expect(decision.setUpstream).toBe(true)
    expect(decision.reason).not.toContain('origin/dev')
  })

  it("names the branch's own ref in the reason, not the upstream", () => {
    const decision = decidePush(
      plan({ ref: 'origin/games/word-scramble', ahead: 16, trackingElsewhere: 'origin/dev' }),
      'games/word-scramble',
    )

    expect(decision.reason).toContain('origin/games/word-scramble')
    expect(decision.reason).not.toContain('origin/dev')
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
