import { describe, it, expect } from 'vitest'
import { createPlan, type PlanDeps, type PlanEvent } from './plan.js'
import { defaultConfig, type Config } from '../config/schema.js'
import type { FileChange, WorkingTreeState } from './types.js'
import type { FileDiff } from '../git/diff.js'
import type { Provider, CompletionRequest } from '../providers/types.js'
import type { RepoStyle } from './style.js'

const style: RepoStyle = {
  format: 'conventional',
  usesScopes: false,
  commonTypes: ['feat', 'fix'],
  commonScopes: [],
  averageTitleLength: 50,
  bodyRate: 0.5,
  samples: ['feat: add thing'],
}

const file = (path: string, staged = false): FileChange => ({
  path,
  status: 'modified',
  staged,
  insertions: 5,
  deletions: 1,
  binary: false,
})

const tree = (files: FileChange[]): WorkingTreeState => ({
  root: '/repo',
  head: 'abc123',
  branch: 'main',
  files,
  operation: 'none',
  detached: false,
})

const diff = (path: string): FileDiff => ({
  path,
  diff: `--- a/${path}\n+++ b/${path}\n+change`,
  truncated: false,
  omitted: false,
})

/** A provider that replies from a queue keyed by schema name. */
function stubProvider(
  handlers: Record<string, (request: CompletionRequest) => unknown>,
): Provider & { calls: string[] } {
  const calls: string[] = []
  return {
    name: 'stub',
    model: 'stub',
    isRemote: false,
    calls,
    async complete<T>(request: CompletionRequest): Promise<T> {
      const key = request.schemaName ?? 'unknown'
      calls.push(key)
      const handler = handlers[key]
      if (!handler) throw new Error(`no stub for schema "${key}"`)
      return handler(request) as T
    },
  }
}

const deps = (
  provider: Provider,
  files: string[],
  onEvent?: (event: PlanEvent) => void,
): PlanDeps => ({
  provider,
  groupingDiffs: files.map(diff),
  getFullDiffs: async (paths) => paths.map(diff),
  onEvent,
})

const config = (overrides: Partial<Config> = {}): Config => ({
  ...defaultConfig(),
  ...overrides,
})

describe('createPlan', () => {
  it('uses a single pass for a small changeset', async () => {
    const paths = ['a.ts', 'b.ts']
    const provider = stubProvider({
      commit_plan: () => ({
        groups: [
          { title: 'feat: a', body: 'Adds a.', files: ['a.ts'], warnings: [] },
          { title: 'fix: b', body: '', files: ['b.ts'], warnings: [] },
        ],
      }),
    })

    const plan = await createPlan(
      tree(paths.map((p) => file(p))),
      config(),
      style,
      deps(provider, paths),
    )

    expect(provider.calls).toEqual(['commit_plan'])
    expect(plan.commits).toHaveLength(2)
    expect(plan.commits[0]!.body).toBe('Adds a.')
    expect(plan.commits[1]!.body).toBeNull()
    expect(plan.unassigned).toEqual([])
  })

  it('uses two passes for a large changeset', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.ts`)
    const provider = stubProvider({
      grouping: () => ({
        groups: [
          { title: 'feat: first half', files: paths.slice(0, 10), warnings: [] },
          { title: 'fix: second half', files: paths.slice(10), warnings: [] },
        ],
      }),
      commit_message: () => ({ title: 'feat: refined title', body: 'Why.' }),
    })

    const plan = await createPlan(
      tree(paths.map((p) => file(p))),
      config(),
      style,
      deps(provider, paths),
    )

    expect(provider.calls[0]).toBe('grouping')
    expect(provider.calls.filter((c) => c === 'commit_message')).toHaveLength(2)
    expect(plan.commits).toHaveLength(2)
    expect(plan.commits[0]!.title).toBe('feat: refined title')
  })

  it('keeps pre-staged files in their own locked group', async () => {
    const provider = stubProvider({
      commit_plan: () => ({
        groups: [{ title: 'feat: loose', body: '', files: ['loose.ts'], warnings: [] }],
      }),
    })

    const plan = await createPlan(
      tree([file('staged.ts', true), file('loose.ts')]),
      config(),
      style,
      deps(provider, ['loose.ts']),
    )

    const locked = plan.commits.find((c) => c.locked)!
    expect(locked.files).toEqual(['staged.ts'])
    expect(plan.unassigned).toEqual([])
  })

  it('routes hinted files without showing them to the model', async () => {
    let promptSeen = ''
    const provider = stubProvider({
      commit_plan: (request) => {
        promptSeen = request.prompt
        return {
          groups: [{ title: 'feat: code', body: '', files: ['src/a.ts'], warnings: [] }],
        }
      },
    })

    const cfg = defaultConfig()
    cfg.grouping.hints = [
      { match: 'pnpm-lock\\.yaml', group: 'chore(deps): update lockfile' },
    ]

    const plan = await createPlan(
      tree([file('src/a.ts'), file('pnpm-lock.yaml')]),
      cfg,
      style,
      deps(provider, ['src/a.ts', 'pnpm-lock.yaml']),
    )

    expect(promptSeen).not.toContain('pnpm-lock.yaml')
    expect(plan.commits.map((c) => c.title)).toContain('chore(deps): update lockfile')
    expect(plan.unassigned).toEqual([])
  })

  it('degrades to one commit when the model fails', async () => {
    const events: PlanEvent[] = []
    const provider = stubProvider({
      commit_plan: () => {
        throw new Error('provider exploded')
      },
    })

    const plan = await createPlan(
      tree([file('a.ts'), file('b.ts')]),
      config(),
      style,
      deps(provider, ['a.ts', 'b.ts'], (event) => events.push(event)),
    )

    expect(events.some((e) => e.type === 'degraded')).toBe(true)
    expect(plan.commits).toHaveLength(1)
    expect(plan.commits[0]!.files).toEqual(['a.ts', 'b.ts'])
    expect(plan.unassigned).toEqual([])
  })

  it('falls back to the provisional subject when one message call fails', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.ts`)
    let messageCalls = 0
    const provider = stubProvider({
      grouping: () => ({
        groups: [
          { title: 'feat: alpha', files: paths.slice(0, 10), warnings: [] },
          { title: 'fix: beta', files: paths.slice(10), warnings: [] },
        ],
      }),
      commit_message: () => {
        messageCalls++
        if (messageCalls === 1) throw new Error('rate limited')
        return { title: 'fix: refined beta', body: '' }
      },
    })

    const plan = await createPlan(
      tree(paths.map((p) => file(p))),
      config(),
      style,
      deps(provider, paths),
    )

    // The failed one keeps its pass-1 title rather than losing the whole group.
    const titles = plan.commits.map((c) => c.title)
    expect(titles).toContain('feat: alpha')
    expect(plan.commits).toHaveLength(2)
  })

  it('never loses a file the model omitted', async () => {
    const provider = stubProvider({
      commit_plan: () => ({
        groups: [{ title: 'feat: a', body: '', files: ['a.ts'], warnings: [] }],
      }),
    })

    const plan = await createPlan(
      tree([file('a.ts'), file('forgotten.ts')]),
      config(),
      style,
      deps(provider, ['a.ts', 'forgotten.ts']),
    )

    expect(plan.unassigned).toEqual(['forgotten.ts'])
  })

  it('merges overflow groups rather than dropping them', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `f${i}.ts`)
    const provider = stubProvider({
      commit_plan: () => ({
        groups: paths.map((p) => ({
          title: `feat: ${p}`,
          body: '',
          files: [p],
          warnings: [],
        })),
      }),
    })

    const cfg = defaultConfig()
    cfg.grouping.maxCommits = 3

    const plan = await createPlan(
      tree(paths.map((p) => file(p))),
      cfg,
      style,
      deps(provider, paths),
    )

    expect(plan.commits).toHaveLength(3)
    // Every file survives the merge.
    const committed = plan.commits.flatMap((c) => c.files)
    expect(committed.sort()).toEqual([...paths].sort())
  })

  it('skips the model entirely when everything is pre-staged', async () => {
    const provider = stubProvider({})

    const plan = await createPlan(
      tree([file('a.ts', true), file('b.ts', true)]),
      config(),
      style,
      deps(provider, []),
    )

    expect(provider.calls).toEqual([])
    expect(plan.commits[0]!.locked).toBe(true)
    expect(plan.commits[0]!.files).toEqual(['a.ts', 'b.ts'])
  })

  it('ignores an invalid hint regex instead of crashing', async () => {
    const provider = stubProvider({
      commit_plan: () => ({
        groups: [{ title: 'feat: a', body: '', files: ['a.ts'], warnings: [] }],
      }),
    })

    const cfg = defaultConfig()
    cfg.grouping.hints = [{ match: '([unclosed', group: 'broken' }]

    const plan = await createPlan(
      tree([file('a.ts')]),
      cfg,
      style,
      deps(provider, ['a.ts']),
    )

    expect(plan.commits).toHaveLength(1)
  })
})
