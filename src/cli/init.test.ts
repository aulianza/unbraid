import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import {
  PRESETS,
  CUSTOM_KEY_ENV,
  findPreset,
  buildConfig,
  normalizeBaseUrl,
  renderConfigFile,
  exportLine,
  profilePath,
} from './init.js'
import { configSchema, defaultConfig } from '../core/config/schema.js'

/** The ready-made services. The self-entered endpoints have their own rules. */
const READY_MADE = PRESETS.filter((preset) => !preset.custom)

describe('presets', () => {
  it('all parse as valid config', () => {
    // A typo in a base URL here produces a 404 that reads like an auth failure,
    // so every preset is validated rather than trusted.
    for (const preset of READY_MADE) {
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

  it.each(READY_MADE.map((p) => [p.key, p] as const))('%s looks sane', (_key, preset) => {
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
    for (const preset of READY_MADE.filter((p) => p.key !== 'ollama')) {
      expect(preset.keyUrl).toMatch(/^https:\/\//)
    }
  })
})

/**
 * A gateway someone runs themselves — OneRouter, LiteLLM, vLLM, a company proxy
 * — has no base URL anybody can fill in for them, so these ask for the three
 * fields instead of listing a service.
 */
describe('self-entered endpoints', () => {
  const custom = PRESETS.filter((preset) => preset.custom)

  it('offers one for each API shape', () => {
    expect(custom.map((preset) => preset.api).sort()).toEqual(['anthropic', 'openai'])
  })

  // Last because they ask three questions where the others ask none.
  it('lists them after every ready-made service', () => {
    const firstCustom = PRESETS.findIndex((preset) => preset.custom)
    expect(firstCustom).toBe(READY_MADE.length)
  })

  // A gateway key is not an OpenAI or Anthropic key. Storing it under their
  // name would shadow — or be shadowed by — a real key for the real service.
  it('keeps their key under a name of its own', () => {
    for (const preset of custom) {
      expect(preset.apiKeyEnv).toBe(CUSTOM_KEY_ENV)
      expect(preset.apiKeyEnv).not.toBe('OPENAI_API_KEY')
      expect(preset.apiKeyEnv).not.toBe('ANTHROPIC_API_KEY')
    }
  })

  it('leaves the endpoint and model to be asked for', () => {
    for (const preset of custom) {
      expect(preset.baseUrl).toBe('')
      expect(preset.model).toBe('')
    }
  })
})

/**
 * The two APIs take different base URLs, and both are easy to get wrong from
 * the documentation somebody is copying from. Pasting a full endpoint into
 * either produced a doubled path and a 404 that reads like a bad key.
 */
describe('normalizeBaseUrl', () => {
  it('keeps a correct OpenAI base as it is', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1', 'openai')).toBe(
      'https://gw.example.com/v1',
    )
  })

  it('trims the OpenAI endpoint when the whole URL was pasted', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1/chat/completions', 'openai')).toBe(
      'https://gw.example.com/v1',
    )
  })

  // The Anthropic provider appends /v1/messages, so the base stops at the host.
  it('drops the version segment for Anthropic', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1', 'anthropic')).toBe(
      'https://gw.example.com',
    )
    expect(normalizeBaseUrl('https://gw.example.com/v1/messages', 'anthropic')).toBe(
      'https://gw.example.com',
    )
  })

  it('leaves a bare host alone for Anthropic', () => {
    expect(normalizeBaseUrl('https://gw.example.com', 'anthropic')).toBe(
      'https://gw.example.com',
    )
  })

  it('strips trailing slashes and surrounding space', () => {
    expect(normalizeBaseUrl('  https://gw.example.com/v1//  ', 'openai')).toBe(
      'https://gw.example.com/v1',
    )
  })

  // A path that merely contains "v1" is not a version suffix.
  it('only trims the suffix, never the middle of a path', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1/openai/v1', 'openai')).toBe(
      'https://gw.example.com/v1/openai/v1',
    )
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

  it('writes a self-entered OpenAI endpoint', () => {
    const preset = findPreset('custom-openai')!
    const config = buildConfig({
      provider: 'openai-compatible',
      preset: { ...preset, baseUrl: 'https://gw.example.com/v1', model: 'gpt-4o-mini' },
    })

    expect(config).toMatchObject({
      provider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          baseUrl: 'https://gw.example.com/v1',
          apiKeyEnv: CUSTOM_KEY_ENV,
          model: 'gpt-4o-mini',
        },
      },
    })
  })

  // Reached through the same question, but served by the other provider: the
  // request bodies and the paths differ, so the two are not interchangeable.
  it('routes a self-entered Anthropic endpoint to the anthropic provider', () => {
    const preset = findPreset('custom-anthropic')!
    const config = buildConfig({
      provider: 'openai-compatible',
      preset: { ...preset, baseUrl: 'https://gw.example.com', model: 'claude-sonnet-5' },
    })

    expect(config).toMatchObject({
      provider: 'anthropic',
      providers: {
        anthropic: {
          baseUrl: 'https://gw.example.com',
          apiKeyEnv: CUSTOM_KEY_ENV,
          model: 'claude-sonnet-5',
        },
      },
    })
    expect(config.providers).not.toHaveProperty('openai-compatible')
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
