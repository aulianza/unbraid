import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './prompts.js'
import { defaultConfig } from '../config/schema.js'
import type { RepoStyle } from './style.js'

const style = (overrides: Partial<RepoStyle> = {}): RepoStyle => ({
  format: 'plain',
  usesScopes: false,
  commonTypes: [],
  commonScopes: [],
  averageTitleLength: 50,
  bodyRate: 0,
  samples: [],
  ...overrides,
})

describe('default message format', () => {
  it('is Conventional Commits', () => {
    expect(defaultConfig().message.format).toBe('conventional')
  })

  it('applies even when the repository writes plain subjects', () => {
    // The whole point of the opinionated default: a plain history does not
    // drag new commits back to plain.
    const prompt = buildSystemPrompt(defaultConfig(), style({ format: 'plain' }))
    expect(prompt).toContain('Conventional Commits')
  })

  it('lists the allowed types', () => {
    const prompt = buildSystemPrompt(defaultConfig(), style())
    for (const type of ['feat', 'fix', 'chore', 'refactor', 'docs', 'test']) {
      expect(prompt).toContain(type)
    }
  })
})

describe('scope guidance', () => {
  it('encourages a scope by default', () => {
    const prompt = buildSystemPrompt(defaultConfig(), style())
    expect(prompt).toMatch(/Prefer a scope/)
    expect(prompt).toContain('feat(auth):')
  })

  it('warns against filler scopes', () => {
    // Guards against `fix(fix):`, the failure mode of mandating scopes.
    const prompt = buildSystemPrompt(defaultConfig(), style())
    expect(prompt).toMatch(/Omit the scope rather than inventing/)
    expect(prompt).toMatch(/Never restate the type as the scope/)
  })

  it('offers the repository existing scopes for reuse', () => {
    const prompt = buildSystemPrompt(
      defaultConfig(),
      style({ commonScopes: ['ui', 'auth', 'i18n'], usesScopes: true }),
    )
    expect(prompt).toContain('ui, auth, i18n')
  })

  it('mandates a scope when configured to require one', () => {
    const config = defaultConfig()
    config.message.scope = 'required'
    const prompt = buildSystemPrompt(config, style())
    expect(prompt).toMatch(/must carry a scope/)
  })

  it('forbids scopes when turned off', () => {
    const config = defaultConfig()
    config.message.scope = 'off'
    const prompt = buildSystemPrompt(config, style())
    expect(prompt).toContain('Do not use scopes.')
  })
})

describe('format: auto', () => {
  it('still follows the repository when explicitly asked to', () => {
    const config = defaultConfig()
    config.message.format = 'auto'
    const prompt = buildSystemPrompt(config, style({ format: 'plain' }))

    expect(prompt).toContain('Plain sentences')
    expect(prompt).not.toContain('Conventional Commits')
  })

  it('follows a gitmoji repository', () => {
    const config = defaultConfig()
    config.message.format = 'auto'
    const prompt = buildSystemPrompt(config, style({ format: 'gitmoji' }))
    expect(prompt).toContain('gitmoji')
  })
})

describe('body guidance', () => {
  it('follows a repository that usually writes bodies', () => {
    const prompt = buildSystemPrompt(defaultConfig(), style({ bodyRate: 0.9 }))
    expect(prompt).toMatch(/usually writes bodies/)
  })

  it('can be turned off entirely', () => {
    const config = defaultConfig()
    config.message.body = 'never'
    const prompt = buildSystemPrompt(config, style())
    expect(prompt).toMatch(/Never write a body/)
  })

  it('always states the path-copying rule', () => {
    const prompt = buildSystemPrompt(defaultConfig(), style())
    expect(prompt).toMatch(/Copy file paths EXACTLY/)
  })
})
