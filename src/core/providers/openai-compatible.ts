import {
  ProviderError,
  withRetry,
  type CompletionRequest,
  type Provider,
} from './types.js'
import { isRetryableStatus } from './anthropic.js'

export interface OpenAiCompatibleOptions {
  baseUrl: string
  /** Omitted for local servers such as Ollama, which need no key. */
  apiKey?: string
  model: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

/**
 * One adapter for every OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq,
 * DeepSeek, Together, and local Ollama — the difference is only `baseUrl`.
 *
 * Structured output uses function calling rather than `response_format:
 * json_schema`. Function calling is supported almost everywhere that claims
 * OpenAI compatibility; strict json_schema is not, and a provider that silently
 * ignores it returns prose that then fails to parse.
 */
export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): Provider {
  const baseUrl = options.baseUrl.replace(/\/$/, '')
  const doFetch = options.fetchImpl ?? fetch

  return {
    name: 'openai-compatible',
    model: options.model,
    // Anything on this machine keeps content local, so the secret guard has
    // nothing to warn about.
    isRemote: !isLocalUrl(baseUrl),

    async complete<T>(request: CompletionRequest): Promise<T> {
      const toolName = request.schemaName ?? 'respond'

      return withRetry(async () => {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
        }
        if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`

        let response: Response
        try {
          response = await doFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: options.model,
              max_tokens: request.maxTokens ?? 4096,
              messages: [
                { role: 'system', content: request.system },
                { role: 'user', content: request.prompt },
              ],
              tools: [
                {
                  type: 'function',
                  function: {
                    name: toolName,
                    description: 'Return the result in the required structure.',
                    parameters: request.schema,
                  },
                },
              ],
              tool_choice: {
                type: 'function',
                function: { name: toolName },
              },
            }),
            signal: request.signal ?? null,
          })
        } catch (error) {
          throw new ProviderError(
            `Could not reach ${baseUrl}: ${(error as Error).message}`,
            'openai-compatible',
            true,
            error,
          )
        }

        if (!response.ok) {
          const detail = await safeText(response)
          throw new ProviderError(
            `${baseUrl} returned ${response.status}: ${detail}`,
            'openai-compatible',
            isRetryableStatus(response.status),
          )
        }

        const payload = (await response.json()) as {
          choices?: Array<{
            message?: {
              tool_calls?: Array<{ function?: { arguments?: string } }>
            }
          }>
        }

        const rawArguments =
          payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments

        if (!rawArguments) {
          throw new ProviderError(
            `${options.model} returned no tool call. The model may not support function calling.`,
            'openai-compatible',
            true,
          )
        }

        try {
          return JSON.parse(rawArguments) as T
        } catch {
          throw new ProviderError(
            `${options.model} returned malformed JSON arguments.`,
            'openai-compatible',
            true,
          )
        }
      })
    },
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local')
    )
  } catch {
    return false
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return '<no body>'
  }
}
