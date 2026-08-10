import { describe, it, expect } from 'vitest'
import { createPrDraft, buildPrPrompt, buildPrSystemPrompt } from './pr.js'
import { defaultConfig } from '../config/schema.js'
import type { BranchSummary } from '../git/branch.js'
import type { Provider, CompletionRequest } from '../providers/types.js'

const summary: BranchSummary = {
  branch: 'feature/settings-sheets',
  base: 'main',
  commits: [
    { sha: 'aaa', subject: 'feat(settings): add account sheet', body: 'Splits profile editing out.' },
    { sha: 'bbb', subject: 'feat(settings): add language sheet', body: '' },
  ],
  filesChanged: 10,
  insertions: 420,
  deletions: 87,
  diffstat: ' src/settings.tsx | 12 +++---\n 2 files changed',
}

function stubProvider(
  response: unknown,
  capture?: (request: CompletionRequest) => void,
): Provider {
  return {
    name: 'stub',
    model: 'stub',
    isRemote: false,
    async complete<T>(request: CompletionRequest): Promise<T> {
      capture?.(request)
      return response as T
    },
  }
}

const response = {
  title: 'Split parent settings into focused bottom sheets',
  summary: 'The settings screen had grown monolithic.',
  changes: ['Extract four sheets', 'Add updateUser to the auth context'],
  testing: 'Manually exercised each sheet on iOS.',
}

describe('buildPrPrompt', () => {
  it('includes every commit subject', () => {
    const prompt = buildPrPrompt(summary)
    expect(prompt).toContain('feat(settings): add account sheet')
    expect(prompt).toContain('feat(settings): add language sheet')
  })

  it('includes commit bodies, which carry the reasoning', () => {
    expect(buildPrPrompt(summary)).toContain('Splits profile editing out.')
  })

  it('states the branch, base, and size', () => {
    const prompt = buildPrPrompt(summary)
    expect(prompt).toContain('feature/settings-sheets')
    expect(prompt).toContain('main')
    expect(prompt).toContain('+420/-87')
  })
})

describe('buildPrSystemPrompt', () => {
  it('forbids inventing context', () => {
    expect(buildPrSystemPrompt(defaultConfig())).toMatch(/Never invent/)
  })

  it('honours the configured language', () => {
    const config = defaultConfig()
    config.message.language = 'id'
    expect(buildPrSystemPrompt(config)).toContain('id')
  })
})

describe('createPrDraft', () => {
  it('renders a title and a structured body', async () => {
    const draft = await createPrDraft(summary, defaultConfig(), stubProvider(response))

    expect(draft.title).toBe('Split parent settings into focused bottom sheets')
    expect(draft.body).toContain('The settings screen had grown monolithic.')
    expect(draft.body).toContain('## Changes')
    expect(draft.body).toContain('- Extract four sheets')
    expect(draft.body).toContain('## Testing')
  })

  it('appends a size footer', async () => {
    const draft = await createPrDraft(summary, defaultConfig(), stubProvider(response))
    expect(draft.body).toContain('2 commits · 10 files changed · +420/-87')
  })

  it('omits the testing section when the model has nothing to say', async () => {
    const draft = await createPrDraft(
      summary,
      defaultConfig(),
      stubProvider({ ...response, testing: '   ' }),
    )
    expect(draft.body).not.toContain('## Testing')
  })

  it('drops empty bullets', async () => {
    const draft = await createPrDraft(
      summary,
      defaultConfig(),
      stubProvider({ ...response, changes: ['Real change', '', '  '] }),
    )
    expect(draft.body.match(/^- /gm)).toHaveLength(1)
  })

  it('lifts a ticket key from the branch name into the title', async () => {
    const config = defaultConfig()
    config.message.ticketPattern = '([A-Z]+-\\d+)'

    const draft = await createPrDraft(
      { ...summary, branch: 'feature/PROJ-42-settings' },
      config,
      stubProvider(response),
    )

    expect(draft.title).toBe(`PROJ-42 ${response.title}`)
  })

  it('does not duplicate a ticket the model already included', async () => {
    const config = defaultConfig()
    config.message.ticketPattern = '([A-Z]+-\\d+)'

    const draft = await createPrDraft(
      { ...summary, branch: 'feature/PROJ-42-settings' },
      config,
      stubProvider({ ...response, title: 'PROJ-42 Split settings' }),
    )

    expect(draft.title).toBe('PROJ-42 Split settings')
  })

  it('asks the provider for the pull_request schema', async () => {
    let seen: CompletionRequest | null = null
    await createPrDraft(
      summary,
      defaultConfig(),
      stubProvider(response, (request) => {
        seen = request
      }),
    )

    expect(seen!.schemaName).toBe('pull_request')
    expect(seen!.schema).toHaveProperty('properties.changes')
  })
})
