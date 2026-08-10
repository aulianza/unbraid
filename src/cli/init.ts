import { stringify } from 'yaml'

export interface Preset {
  key: string
  label: string
  baseUrl: string
  apiKeyEnv: string
  model: string
  /** Where to get a key, or null when none is needed. */
  keyUrl: string | null
  note?: string
}

/**
 * Ready-made settings for the OpenAI-compatible endpoints people actually use.
 *
 * The base URLs and default models are the fiddly part — getting one character
 * wrong produces a 404 that reads like an auth failure — so they are filled in
 * rather than asked for.
 */
export const PRESETS: Preset[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4o',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter (many models, one key)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: 'anthropic/claude-sonnet-4.5',
    keyUrl: 'https://openrouter.ai/keys',
  },
  // Two entries deliberately. z.ai's Coding Plan is served from a different
  // path, and pointing a Coding Plan key at the general endpoint returns a 404
  // that reads like an authentication failure. The two are not interchangeable.
  {
    key: 'zai',
    label: 'Z.AI / GLM — pay-as-you-go API',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    model: 'glm-4.7',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    key: 'zai-coding',
    label: 'Z.AI / GLM — Coding Plan subscription',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    model: 'glm-4.7',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    note: 'Coding Plan only. A Coding Plan key on the pay-as-you-go endpoint returns 404.',
  },
  {
    key: 'groq',
    label: 'Groq (fast, free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek (cheap)',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'ollama',
    label: 'Ollama (runs on your machine, free, nothing leaves your laptop)',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    model: 'qwen2.5-coder',
    keyUrl: null,
    note: 'Needs Ollama running locally: `ollama serve` and `ollama pull qwen2.5-coder`.',
  },
]

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((preset) => preset.key === key)
}

export interface InitAnswers {
  provider: 'claude-cli' | 'anthropic' | 'openai-compatible'
  preset?: Preset
  anthropicModel?: string
  granularity?: 'fine' | 'semantic' | 'coarse'
  hunks?: boolean
}

/**
 * Build the config file contents from the answers.
 *
 * Only writes what differs from the defaults. A config file full of restated
 * defaults is noise, and it silently freezes today's defaults in place — a later
 * improvement to any of them would never reach this user.
 */
export function buildConfig(answers: InitAnswers): Record<string, unknown> {
  const config: Record<string, unknown> = { provider: answers.provider }

  if (answers.provider === 'anthropic' && answers.anthropicModel) {
    config.providers = { anthropic: { model: answers.anthropicModel } }
  }

  if (answers.provider === 'openai-compatible' && answers.preset) {
    const { baseUrl, apiKeyEnv, model } = answers.preset
    config.providers = { 'openai-compatible': { baseUrl, apiKeyEnv, model } }
  }

  const grouping: Record<string, unknown> = {}
  if (answers.granularity && answers.granularity !== 'semantic') {
    grouping.granularity = answers.granularity
  }
  if (answers.hunks) grouping.hunks = true
  if (Object.keys(grouping).length > 0) config.grouping = grouping

  return config
}

export function renderConfigFile(answers: InitAnswers): string {
  return [
    '# unbraid configuration',
    '# Every setting not listed here uses its default.',
    '# Full reference: https://github.com/aulianza/unbraid#configuration',
    '',
    stringify(buildConfig(answers)).trimEnd(),
    '',
  ].join('\n')
}

/** The shell line a user must add for a provider that needs a key. */
export function exportLine(envVar: string): string {
  return `export ${envVar}="your-key-here"`
}

/** Best guess at which shell profile to suggest. */
export function profilePath(shell: string | undefined, home: string): string {
  if (shell?.includes('zsh')) return `${home}/.zshrc`
  if (shell?.includes('fish')) return `${home}/.config/fish/config.fish`
  return `${home}/.bashrc`
}
