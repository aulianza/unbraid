import { describe, it, expect } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAiCompatibleProvider, isLocalUrl } from './openai-compatible.js'
import { resolveProvider, NoProviderError } from './resolve.js'
import { defaultConfig } from '../config/schema.js'

const request = {
  system: 'sys',
  prompt: 'user',
  schema: { type: 'object', properties: {} },
  schemaName: 'respond',
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('anthropic provider', () => {
  it('reads the forced tool_use block', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetchImpl: async () =>
        jsonResponse({
          content: [
            { type: 'text', text: 'ignore me' },
            { type: 'tool_use', name: 'respond', input: { groups: ['x'] } },
          ],
        }),
    })

    await expect(provider.complete(request)).resolves.toEqual({ groups: ['x'] })
  })

  it('forces the tool so the model cannot reply in prose', async () => {
    let sent: Record<string, unknown> = {}
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String((init as RequestInit).body))
        return jsonResponse({ content: [{ type: 'tool_use', input: {} }] })
      },
    })

    await provider.complete(request)
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'respond' })
  })

  it('is marked remote so the secret guard applies', () => {
    expect(createAnthropicProvider({ apiKey: 'k' }).isRemote).toBe(true)
  })

  it('does not retry an authentication failure', async () => {
    let calls = 0
    const provider = createAnthropicProvider({
      apiKey: 'bad',
      fetchImpl: async () => {
        calls++
        return jsonResponse({ error: 'invalid key' }, 401)
      },
    })

    await expect(provider.complete(request)).rejects.toThrow(/401/)
    expect(calls).toBe(1)
  })

  it('retries a rate limit', async () => {
    let calls = 0
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetchImpl: async () => {
        calls++
        if (calls < 2) return jsonResponse({ error: 'slow down' }, 429)
        return jsonResponse({ content: [{ type: 'tool_use', input: { ok: true } }] })
      },
    })

    await expect(provider.complete(request)).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('fails clearly when no tool_use block comes back', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({ content: [{ type: 'text', text: 'hi' }] }),
    })

    await expect(provider.complete(request)).rejects.toThrow(/no tool_use/)
  })
})

describe('openai-compatible provider', () => {
  it('parses function-call arguments', async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      model: 'gpt-4o',
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { arguments: '{"groups":[{"title":"feat: a"}]}' } },
                ],
              },
            },
          ],
        }),
    })

    await expect(provider.complete(request)).resolves.toEqual({
      groups: [{ title: 'feat: a' }],
    })
  })

  it('omits the Authorization header when no key is set', async () => {
    let headers: Record<string, string> = {}
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder',
      fetchImpl: async (_url, init) => {
        headers = (init as RequestInit).headers as Record<string, string>
        return jsonResponse({
          choices: [{ message: { tool_calls: [{ function: { arguments: '{}' } }] } }],
        })
      },
    })

    await provider.complete(request)
    expect(headers.authorization).toBeUndefined()
  })

  it('treats a local endpoint as non-remote', () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen',
    })
    expect(provider.isRemote).toBe(false)
  })

  it('explains itself when the model does not support function calling', async () => {
    const provider = createOpenAiCompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'weak-model',
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: 'here you go!' } }] }),
    })

    await expect(provider.complete(request)).rejects.toThrow(/function calling/)
  })
})

describe('isLocalUrl', () => {
  it.each([
    ['http://localhost:11434/v1', true],
    ['http://127.0.0.1:8080', true],
    ['http://mac.local:1234', true],
    ['https://api.openai.com/v1', false],
    ['https://openrouter.ai/api/v1', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLocalUrl(url)).toBe(expected)
  })
})

describe('resolveProvider', () => {
  it('prefers the Claude CLI when it is installed', async () => {
    const provider = await resolveProvider(defaultConfig(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      claudeAvailable: async () => true,
    })
    expect(provider.name).toBe('claude-cli')
  })

  it('falls back to an Anthropic key when the CLI is absent', async () => {
    const provider = await resolveProvider(defaultConfig(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      claudeAvailable: async () => false,
    })
    expect(provider.name).toBe('anthropic')
  })

  it('falls back to an OpenAI-compatible key last', async () => {
    const provider = await resolveProvider(defaultConfig(), {
      env: { OPENAI_API_KEY: 'k' },
      claudeAvailable: async () => false,
    })
    expect(provider.name).toBe('openai-compatible')
  })

  it('explains how to fix things when nothing is configured', async () => {
    await expect(
      resolveProvider(defaultConfig(), { env: {}, claudeAvailable: async () => false }),
    ).rejects.toBeInstanceOf(NoProviderError)

    await expect(
      resolveProvider(defaultConfig(), { env: {}, claudeAvailable: async () => false }),
    ).rejects.toThrow(/claude\.com\/claude-code/)
  })

  it('names the missing variable when a provider is chosen explicitly', async () => {
    const config = defaultConfig()
    config.provider = 'anthropic'

    await expect(resolveProvider(config, { env: {} })).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set/,
    )
  })
})
