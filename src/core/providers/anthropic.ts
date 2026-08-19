import {
  ProviderError,
  withRetry,
  type CompletionRequest,
  type Provider,
} from './types.js'

export interface AnthropicOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

const DEFAULT_MODEL = 'claude-sonnet-5'
const API_VERSION = '2023-06-01'

/**
 * Direct Anthropic Messages API provider.
 *
 * Uses `fetch` rather than the official SDK deliberately. unbraid is run through
 * `npx`, where every dependency is download time the user waits through, and the
 * subset of the API used here is one POST with one tool definition.
 *
 * Structured output is obtained by declaring a single tool and forcing its use,
 * which is the documented way to get schema-conforming JSON out of the Messages
 * API — more reliable than asking for JSON in the prompt and parsing the reply.
 */
export function createAnthropicProvider(options: AnthropicOptions): Provider {
  const model = resolveModel(options.model)
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const doFetch = options.fetchImpl ?? fetch

  return {
    name: 'anthropic',
    model,
    isRemote: true,

    async complete<T>(request: CompletionRequest): Promise<T> {
      const toolName = request.schemaName ?? 'respond'

      return withRetry(async () => {
        let response: Response
        try {
          response = await doFetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': options.apiKey,
              'anthropic-version': API_VERSION,
            },
            body: JSON.stringify({
              model,
              max_tokens: request.maxTokens ?? 4096,
              system: request.system,
              messages: [{ role: 'user', content: request.prompt }],
              tools: [
                {
                  name: toolName,
                  description: 'Return the result in the required structure.',
                  input_schema: request.schema,
                },
              ],
              tool_choice: { type: 'tool', name: toolName },
            }),
            signal: request.signal ?? null,
          })
        } catch (error) {
          throw new ProviderError(
            `Could not reach ${baseUrl}: ${(error as Error).message}`,
            'anthropic',
            true,
            error,
          )
        }

        if (!response.ok) {
          const detail = await safeText(response)
          throw new ProviderError(
            `${baseUrl} returned ${response.status}: ${detail}`,
            'anthropic',
            isRetryableStatus(response.status),
          )
        }

        const payload = (await response.json()) as {
          content?: Array<{ type: string; name?: string; input?: unknown }>
        }
        const toolUse = payload.content?.find((block) => block.type === 'tool_use')

        if (!toolUse?.input) {
          throw new ProviderError(
            'Anthropic returned no tool_use block, so there is no structured result to read.',
            'anthropic',
            true,
          )
        }

        return toolUse.input as T
      })
    },
  }
}

export function resolveModel(model?: string): string {
  return !model || model === 'auto' ? DEFAULT_MODEL : model
}

/**
 * 429 and 5xx are transient. 4xx otherwise means a bad key, a malformed schema,
 * or an unknown model — all of which fail identically on a retry.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return '<no body>'
  }
}
