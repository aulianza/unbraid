/** A JSON Schema object. Every provider takes one and returns matching data. */
export type JsonSchema = Record<string, unknown>

export interface CompletionRequest {
  system: string
  prompt: string
  /** The shape the response must take. Enforced by the provider, not by parsing. */
  schema: JsonSchema
  /** A short name for the schema, required by some tool-calling APIs. */
  schemaName?: string
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * The single boundary between unbraid and any AI backend.
 *
 * Structured output is the provider's problem: a provider takes a schema and
 * returns a validated object. Retries, parsing, and API quirks stay behind this
 * line so the engine never contains a `JSON.parse` or a regex over model output.
 */
export interface Provider {
  readonly name: string
  readonly model: string
  /**
   * True when request content leaves this machine.
   *
   * The secret guard uses this: sending a diff to api.anthropic.com warrants a
   * prompt, sending it to a local Ollama or to the already-authenticated Claude
   * CLI does not.
   */
  readonly isRemote: boolean
  complete<T = unknown>(request: CompletionRequest): Promise<T>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  /** Injected in tests so retry logic does not actually sleep. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Retry a provider call with exponential backoff.
 *
 * Only retries errors explicitly marked retryable. A schema violation or a bad
 * API key will fail identically on the second attempt, and retrying it just
 * makes the user wait longer for the same message.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const retryable = error instanceof ProviderError ? error.retryable : false
      if (!retryable || attempt === attempts) break
      await sleep(baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw lastError
}
