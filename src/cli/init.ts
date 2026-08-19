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
  /**
   * Which API the endpoint speaks.
   *
   * Everything here has been OpenAI-shaped until now. An endpoint that speaks
   * Anthropic's Messages API needs the other provider, and the two are not
   * interchangeable — the request bodies differ, and so does the path.
   */
  api?: 'openai' | 'anthropic'
  /**
   * Ask for the endpoint and model rather than filling them in.
   *
   * The listed services have one known base URL each. A gateway someone runs
   * themselves — OneRouter, LiteLLM, vLLM, a company proxy — does not, so the
   * only useful thing to offer is the three fields it takes.
   */
  custom?: boolean
}

/**
 * Where a key for a self-entered endpoint is stored.
 *
 * Not OPENAI_API_KEY or ANTHROPIC_API_KEY: a gateway key is not one of those,
 * and writing it under their name would have it picked up by — or quietly
 * shadow — a real key for the actual service.
 */
export const CUSTOM_KEY_ENV = 'UNBRAID_API_KEY'

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
  // Last, because they ask three questions where the others ask none. They are
  // also the only entries that cover a service nobody has heard of yet.
  {
    key: 'custom-openai',
    label: 'Any OpenAI-compatible endpoint — enter your own URL',
    baseUrl: '',
    apiKeyEnv: CUSTOM_KEY_ENV,
    model: '',
    keyUrl: null,
    api: 'openai',
    custom: true,
    note: 'For a gateway or proxy: OneRouter, LiteLLM, vLLM, LM Studio, your own.',
  },
  {
    key: 'custom-anthropic',
    label: 'Any Anthropic-compatible endpoint — enter your own URL',
    baseUrl: '',
    apiKeyEnv: CUSTOM_KEY_ENV,
    model: '',
    keyUrl: null,
    api: 'anthropic',
    custom: true,
    note: 'For anything speaking Anthropic\'s Messages API rather than OpenAI\'s.',
  },
]

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((preset) => preset.key === key)
}

/**
 * Make a pasted URL into the base URL the provider expects.
 *
 * The two APIs want different things, and both are easy to get wrong from the
 * documentation someone is copying from:
 *
 *   - the OpenAI path appends `/chat/completions`, so the base ends at `/v1`
 *   - the Anthropic path appends `/v1/messages`, so the base ends at the host
 *
 * Paste a full endpoint into either and you get `/v1/chat/completions/chat/
 * completions` or `/v1/v1/messages` — a 404 that reads like a bad key. So the
 * endpoint suffix is trimmed if it is there, and for Anthropic a trailing `/v1`
 * as well, since that is the form every Anthropic example shows.
 */
export function normalizeBaseUrl(url: string, api: 'openai' | 'anthropic'): string {
  let trimmed = url.trim().replace(/\/+$/, '')

  if (api === 'openai') {
    trimmed = trimmed.replace(/\/chat\/completions$/, '')
  } else {
    trimmed = trimmed.replace(/\/v1\/messages$/, '').replace(/\/messages$/, '')
    trimmed = trimmed.replace(/\/v1$/, '')
  }

  return trimmed
}

export interface InitAnswers {
  provider: 'claude-cli' | 'codex-cli' | 'anthropic' | 'openai-compatible'
  preset?: Preset
  anthropicModel?: string
  codexModel?: string
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

  if (
    answers.provider === 'codex-cli' &&
    answers.codexModel &&
    answers.codexModel !== 'auto'
  ) {
    config.providers = { 'codex-cli': { model: answers.codexModel } }
  }

  if (answers.provider === 'anthropic' && answers.anthropicModel) {
    config.providers = { anthropic: { model: answers.anthropicModel } }
  }

  // A preset that speaks Anthropic's API is served by the anthropic provider,
  // not the OpenAI-shaped one. The choice of provider follows from the preset
  // rather than from which question the user answered to reach it.
  if (answers.preset?.api === 'anthropic') {
    const { baseUrl, apiKeyEnv, model } = answers.preset
    config.provider = 'anthropic'
    config.providers = { anthropic: { baseUrl, apiKeyEnv, model } }
  } else if (answers.provider === 'openai-compatible' && answers.preset) {
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
