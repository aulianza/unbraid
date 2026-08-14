import type { Config } from '../config/schema.js'
import { readCredentials, lookupKey, type Credentials } from '../config/credentials.js'
import type { Provider } from './types.js'
import { createClaudeCliProvider, isClaudeCliAvailable } from './claude-cli.js'
import { createCodexCliProvider, isCodexCliAvailable } from './codex-cli.js'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAiCompatibleProvider } from './openai-compatible.js'

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  /** Injected in tests so resolution does not depend on what is installed. */
  claudeAvailable?: (bin: string) => Promise<boolean>
  codexAvailable?: (bin: string) => Promise<boolean>
  /** Injected in tests; read from disk otherwise. */
  credentials?: Credentials
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
  // Keys saved by `unbraid init` live outside any repository; the environment
  // still wins, so an exported key keeps overriding a stored one.
  const credentials = options.credentials ?? (await readCredentials())
  const checkClaude = options.claudeAvailable ?? isClaudeCliAvailable
  const checkCodex = options.codexAvailable ?? isCodexCliAvailable
  const providers = config.providers

  const claudeBin = providers['claude-cli'].bin
  const anthropicKey = lookupKey(providers.anthropic.apiKeyEnv, env, credentials)
  const openAiKey = lookupKey(
    providers['openai-compatible'].apiKeyEnv,
    env,
    credentials,
  )

  const buildClaude = () =>
    createClaudeCliProvider({
      bin: claudeBin,
      model: config.model === 'auto' ? 'auto' : config.model,
      extraArgs: providers['claude-cli'].extraArgs,
    })

  const buildCodex = () =>
    createCodexCliProvider({
      bin: providers['codex-cli'].bin,
      model:
        config.model === 'auto' ? providers['codex-cli'].model : config.model,
      extraArgs: providers['codex-cli'].extraArgs,
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

    case 'codex-cli':
      return buildCodex()

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
      // Subscription-backed CLIs first: they cost the user nothing beyond what
      // they already pay for, and need no key to be configured.
      if (await checkClaude(claudeBin)) return buildClaude()
      if (await checkCodex(providers['codex-cli'].bin)) return buildCodex()
      if (anthropicKey) return buildAnthropic(anthropicKey)
      if (openAiKey) return buildOpenAi(openAiKey)

      throw new NoProviderError(
        [
          'No AI provider available. Pick one of:',
          '',
          '  1. Install Claude Code or the Codex CLI and sign in — free with an',
          '     existing subscription:',
          '       https://claude.com/claude-code',
          '       https://developers.openai.com/codex/cli',
          '  2. Run `unbraid init` and paste an API key when asked.',
          `  3. Or export ${providers.anthropic.apiKeyEnv} or ${providers['openai-compatible'].apiKeyEnv} yourself.`,
          '',
          'Then re-run unbraid.',
        ].join('\n'),
      )
    }
  }
}
