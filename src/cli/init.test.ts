import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import {
  PRESETS,
  findPreset,
  buildConfig,
  renderConfigFile,
  exportLine,
  profilePath,
} from './init.js'
import { configSchema, defaultConfig } from '../core/config/schema.js'

describe('presets', () => {
  it('all parse as valid config', () => {
    // A typo in a base URL here produces a 404 that reads like an auth failure,
    // so every preset is validated rather than trusted.
    for (const preset of PRESETS) {
      const config = configSchema.parse({
        provider: 'openai-compatible',
        providers: {
          'openai-compatible': {
            baseUrl: preset.baseUrl,
            apiKeyEnv: preset.apiKeyEnv,
            model: preset.model,
          },
        },
      })
      expect(config.providers['openai-compatible'].baseUrl).toBe(preset.baseUrl)
    }
  })

  it.each(PRESETS.map((p) => [p.key, p] as const))('%s looks sane', (_key, preset) => {
    expect(preset.baseUrl).toMatch(/^https?:\/\//)
    expect(preset.model.length).toBeGreaterThan(0)
    expect(preset.apiKeyEnv).toMatch(/^[A-Z0-9_]+$/)
  })

  it('marks Ollama as needing no key', () => {
    expect(findPreset('ollama')!.keyUrl).toBeNull()
  })

  // Both z.ai endpoints exist because they are not interchangeable: a Coding
  // Plan key sent to the pay-as-you-go URL returns a 404 that looks like auth.
  it('offers both z.ai endpoints, on different paths', () => {
    const paygo = findPreset('zai')!
    const coding = findPreset('zai-coding')!

    expect(paygo.baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(coding.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(paygo.baseUrl).not.toBe(coding.baseUrl)
    expect(coding.note).toMatch(/404/)
  })

  it('gives every keyed provider somewhere to get a key', () => {
    for (const preset of PRESETS.filter((p) => p.key !== 'ollama')) {
      expect(preset.keyUrl).toMatch(/^https:\/\//)
    }
  })
})

describe('buildConfig', () => {
  it('writes only the provider for Claude Code', () => {
    expect(buildConfig({ provider: 'claude-cli' })).toEqual({ provider: 'claude-cli' })
  })

  // Restating defaults freezes today's values into the user's file, so a later
  // improvement to any default would never reach them.
  it('omits settings left at their default', () => {
    const config = buildConfig({ provider: 'claude-cli', granularity: 'semantic' })
    expect(config).not.toHaveProperty('grouping')
  })

  it('records a non-default granularity', () => {
    expect(buildConfig({ provider: 'claude-cli', granularity: 'fine' })).toMatchObject({
      grouping: { granularity: 'fine' },
    })
  })

  it('records hunks only when enabled', () => {
    expect(buildConfig({ provider: 'claude-cli', hunks: true })).toMatchObject({
      grouping: { hunks: true },
    })
    expect(buildConfig({ provider: 'claude-cli', hunks: false })).not.toHaveProperty('grouping')
  })

  it('writes the preset details for an OpenAI-compatible provider', () => {
    const config = buildConfig({
      provider: 'openai-compatible',
      preset: findPreset('groq'),
    })

    expect(config).toMatchObject({
      provider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyEnv: 'GROQ_API_KEY',
        },
      },
    })
  })

  it('writes the chosen Anthropic model', () => {
    expect(
      buildConfig({ provider: 'anthropic', anthropicModel: 'claude-opus-5' }),
    ).toMatchObject({ providers: { anthropic: { model: 'claude-opus-5' } } })
  })

  it('writes only the provider for Codex CLI', () => {
    expect(buildConfig({ provider: 'codex-cli' })).toEqual({ provider: 'codex-cli' })
  })

  it('writes an explicit Codex model but not the auto placeholder', () => {
    expect(buildConfig({ provider: 'codex-cli', codexModel: 'o3' })).toMatchObject({
      providers: { 'codex-cli': { model: 'o3' } },
    })
    // "auto" is how the wizard records "no answer"; writing it out would pin a
    // model choice the user never made.
    expect(
      buildConfig({ provider: 'codex-cli', codexModel: 'auto' }),
    ).not.toHaveProperty('providers')
  })
})

describe('renderConfigFile', () => {
  it('produces YAML that parses back to the same settings', () => {
    const answers = {
      provider: 'openai-compatible' as const,
      preset: findPreset('ollama'),
      granularity: 'fine' as const,
    }
    const parsed = parse(renderConfigFile(answers))

    expect(parsed).toEqual(buildConfig(answers))
  })

  it('produces a file the real loader accepts', () => {
    const text = renderConfigFile({ provider: 'anthropic', granularity: 'coarse' })
    const config = configSchema.parse(parse(text))

    expect(config.provider).toBe('anthropic')
    expect(config.grouping.granularity).toBe('coarse')
    // Everything untouched still falls back to the defaults.
    expect(config.message.format).toBe(defaultConfig().message.format)
  })

  it('links to the full reference', () => {
    expect(renderConfigFile({ provider: 'claude-cli' })).toContain('#configuration')
  })
})

describe('shell guidance', () => {
  it('quotes the key so shell characters cannot break it', () => {
    expect(exportLine('ANTHROPIC_API_KEY')).toBe('export ANTHROPIC_API_KEY="your-key-here"')
  })

  it.each([
    ['/bin/zsh', '/home/u/.zshrc'],
    ['/usr/local/bin/fish', '/home/u/.config/fish/config.fish'],
    ['/bin/bash', '/home/u/.bashrc'],
    [undefined, '/home/u/.bashrc'],
  ])('suggests the right profile for %s', (shell, expected) => {
    expect(profilePath(shell, '/home/u')).toBe(expected)
  })
})
