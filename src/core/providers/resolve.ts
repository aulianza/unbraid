import type { Config } from '../config/schema.js'
import type { Provider } from './types.js'
import { createClaudeCliProvider, isClaudeCliAvailable } from './claude-cli.js'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  /** Injected in tests so resolution does not depend on what is installed. */
  claudeAvailable?: (bin: string) => Promise<boolean>
}

export class NoProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoProviderError'
  }
}

/**
 * Turn configuration into a usable Provider.
 *
 * `provider: auto` prefers the Claude CLI because it is the only option that
 * costs the user nothing and needs no setup. It falls back to whichever API key
 * is actually present, and if none is, fails with instructions rather than a
 * generic "unauthorized" from an API three layers down.
 */
export async function resolveProvider(
  config: Config,
  options: ResolveOptions = {},
): Promise<Provider> {
  const env = options.env ?? process.env
  const checkClaude = options.claudeAvailable ?? isClaudeCliAvailable
  const providers = config.providers

  const claudeBin = providers['claude-cli'].bin
  const anthropicKey = env[providers.anthropic.apiKeyEnv]
  const openAiKey = env[providers['openai-compatible'].apiKeyEnv]

  const buildClaude = () =>
    createClaudeCliProvider({
      bin: claudeBin,
      model: config.model === 'auto' ? 'auto' : config.model,
      extraArgs: providers['claude-cli'].extraArgs,
    })

  const buildAnthropic = (key: string) =>
    createAnthropicProvider({
      apiKey: key,
      model: config.model === 'auto' ? providers.anthropic.model : config.model,
    })

  const buildOpenAi = (key?: string) =>
    createOpenAiCompatibleProvider({
      baseUrl: providers['openai-compatible'].baseUrl,
      apiKey: key,
      model:
        config.model === 'auto'
          ? providers['openai-compatible'].model
          : config.model,
    })

  switch (config.provider) {
    case 'claude-cli':
      return buildClaude()

    case 'anthropic':
      if (!anthropicKey) {
        throw new NoProviderError(
          `provider is "anthropic" but ${providers.anthropic.apiKeyEnv} is not set.`,
        )
      }
      return buildAnthropic(anthropicKey)

    case 'openai-compatible':
      return buildOpenAi(openAiKey)

    case 'auto': {
      if (await checkClaude(claudeBin)) return buildClaude()
      if (anthropicKey) return buildAnthropic(anthropicKey)
      if (openAiKey) return buildOpenAi(openAiKey)

      throw new NoProviderError(
        [
          'No AI provider available. Pick one of:',
          '',
          '  1. Install Claude Code and sign in — free with an existing subscription:',
          '       https://claude.com/claude-code',
          `  2. export ${providers.anthropic.apiKeyEnv}=...`,
          `  3. export ${providers['openai-compatible'].apiKeyEnv}=... (works with OpenAI, OpenRouter, Groq, Ollama)`,
          '',
          'Then re-run unbraid.',
        ].join('\n'),
      )
    }
  }
}
