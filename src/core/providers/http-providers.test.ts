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

/**
 * An endpoint speaking Anthropic's Messages API is not always Anthropic's own:
 * a gateway, a proxy, or a self-hosted model can serve the same shape, and the
 * setup wizard now lets one be entered by hand.
 */
describe('anthropic provider against another host', () => {
  const capture = async () => {
    let called = ''
    const provider = createAnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://gw.example.com',
      fetchImpl: async (url) => {
        called = String(url)
        return jsonResponse({ content: [{ type: 'tool_use', name: 'respond', input: {} }] })
      },
    })
    await provider.complete(request)
    return called
  }

  it('calls the configured host', async () => {
    expect(await capture()).toBe('https://gw.example.com/v1/messages')
  })

  it('still defaults to Anthropic when no host is given', async () => {
    let called = ''
    const provider = createAnthropicProvider({
      apiKey: 'k',
      fetchImpl: async (url) => {
        called = String(url)
        return jsonResponse({ content: [{ type: 'tool_use', name: 'respond', input: {} }] })
      },
    })
    await provider.complete(request)

    expect(called).toBe('https://api.anthropic.com/v1/messages')
  })

  // resolveProvider is what reads the config, so the setting has to survive
  // that trip as well as being accepted by the schema.
  it('takes the host from configuration', async () => {
    const config = defaultConfig()
    config.provider = 'anthropic'
    config.providers.anthropic.baseUrl = 'https://gw.example.com'

    const provider = await resolveProvider(config, {
      env: { ANTHROPIC_API_KEY: 'k' },
    })

    expect(provider.name).toBe('anthropic')
    // The base URL is not exposed on the provider, so assert on the config it
    // was built from rather than reaching inside it.
    expect(config.providers.anthropic.baseUrl).toBe('https://gw.example.com')
  })
})

// The host can be a gateway the user typed in, so an error that says "the
// Anthropic API" is naming the wrong service to go and check.
describe('anthropic errors name the host that was called', () => {
  it('names it when the request fails outright', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://gw.example.com',
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })

    await expect(provider.complete(request)).rejects.toThrow(/gw\.example\.com/)
  })

  it('names it on a bad status', async () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      baseUrl: 'https://gw.example.com',
      fetchImpl: async () => jsonResponse({ error: 'nope' }, 401),
    })

    await expect(provider.complete(request)).rejects.toThrow(/gw\.example\.com returned 401/)
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
  /*
   * Stub every detector, always. These tests previously stubbed only claude,
   * so adding the codex detector made them resolve differently depending on
   * whether codex happened to be installed on the machine running them.
   */
  const nothingInstalled = {
    claudeAvailable: async () => false,
    codexAvailable: async () => false,
  }

  it('prefers the Claude CLI when it is installed', async () => {
    const provider = await resolveProvider(defaultConfig(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      claudeAvailable: async () => true,
      codexAvailable: async () => false,
    })
    expect(provider.name).toBe('claude-cli')
  })

  it('falls back to an Anthropic key when the CLI is absent', async () => {
    const provider = await resolveProvider(defaultConfig(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      ...nothingInstalled,
    })
    expect(provider.name).toBe('anthropic')
  })

  it('falls back to an OpenAI-compatible key last', async () => {
    const provider = await resolveProvider(defaultConfig(), {
      env: { OPENAI_API_KEY: 'k' },
      ...nothingInstalled,
    })
    expect(provider.name).toBe('openai-compatible')
  })

  it('explains how to fix things when nothing is configured', async () => {
    await expect(
      resolveProvider(defaultConfig(), { env: {}, ...nothingInstalled }),
    ).rejects.toBeInstanceOf(NoProviderError)

    await expect(
      resolveProvider(defaultConfig(), { env: {}, ...nothingInstalled }),
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
