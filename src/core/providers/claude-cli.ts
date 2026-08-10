import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ProviderError,
  withRetry,
  type CompletionRequest,
  type Provider,
} from './types.js'

const execFileAsync = promisify(execFile)

export interface ClaudeCliOptions {
  bin?: string
  /** Model alias ('sonnet', 'opus') or full id. 'auto' resolves to 'sonnet'. */
  model?: string
  extraArgs?: string[]
  /** Injected in tests. */
  run?: (bin: string, args: string[]) => Promise<string>
}

/**
 * Build the argv for a headless `claude` invocation.
 *
 * Exported separately from the provider because the flag choices below are
 * load-bearing and were established empirically against Claude Code v2.1.226.
 * Testing them requires no API call.
 *
 * Deliberate omissions, each of which breaks structured output or auth:
 *
 *   --max-turns 1   returns `structured_output: null`. Structured output is
 *                   delivered through a tool call, which needs a second turn to
 *                   complete. Capping turns truncates it away.
 *
 *   --bare          forces auth to ANTHROPIC_API_KEY or apiKeyHelper and never
 *                   reads OAuth or the keychain. That silently disables the
 *                   subscription path, which is the entire reason this adapter
 *                   exists.
 */
export function buildClaudeArgs(
  request: CompletionRequest,
  options: ClaudeCliOptions = {},
): string[] {
  const model = resolveModel(options.model)

  return [
    '-p',
    request.prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(request.schema),
    '--model',
    model,
    '--system-prompt',
    request.system,
    // Do not inherit the user's MCP servers or settings into unbraid's calls.
    '--strict-mcp-config',
    '--settings',
    '{}',
    ...(options.extraArgs ?? []),
  ]
}

export function resolveModel(model?: string): string {
  return !model || model === 'auto' ? 'sonnet' : model
}

/**
 * Extract the structured payload from a `--output-format json` response.
 *
 * The response carries the same data twice: `result` as a JSON *string*, and
 * `structured_output` as the parsed object. Read `structured_output` — `result`
 * is prose when no schema was supplied, so parsing it is a trap that works in
 * testing and fails in production.
 */
export function parseClaudeResponse<T>(stdout: string): T {
  let envelope: {
    is_error?: boolean
    subtype?: string
    result?: unknown
    structured_output?: unknown
  }

  try {
    envelope = JSON.parse(stdout)
  } catch {
    throw new ProviderError(
      `claude returned output that was not JSON: ${stdout.slice(0, 200)}`,
      'claude-cli',
      true,
    )
  }

  if (envelope.is_error) {
    throw new ProviderError(
      `claude reported an error: ${envelope.subtype ?? 'unknown'}`,
      'claude-cli',
      true,
    )
  }

  if (envelope.structured_output == null) {
    throw new ProviderError(
      'claude returned no structured_output. This usually means the schema was rejected, or that turns were capped before the tool call completed.',
      'claude-cli',
      true,
    )
  }

  return envelope.structured_output as T
}

/**
 * The zero-configuration default provider: shell out to an already-installed,
 * already-authenticated Claude Code CLI.
 *
 * Costs the user nothing beyond their existing subscription. The tradeoff is
 * speed — each invocation reloads Claude Code's own system prompt (tens of
 * thousands of tokens) and takes several seconds. The engine hides most of that
 * by running pass 2 groups concurrently.
 */
export function createClaudeCliProvider(
  options: ClaudeCliOptions = {},
): Provider {
  const bin = options.bin ?? 'claude'
  const model = resolveModel(options.model)

  const run =
    options.run ??
    (async (binary: string, args: string[]) => {
      const { stdout } = await execFileAsync(binary, args, {
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      })
      return stdout
    })

  return {
    name: 'claude-cli',
    model,
    // Content goes to Anthropic, but through credentials the user already
    // established and a binary they already trust. No new egress path is opened,
    // so the secret guard does not need to interrupt.
    isRemote: false,

    async complete<T>(request: CompletionRequest): Promise<T> {
      return withRetry(async () => {
        const args = buildClaudeArgs(request, { ...options, model })
        let stdout: string
        try {
          stdout = await run(bin, args)
        } catch (error) {
          const e = error as NodeJS.ErrnoException
          if (e.code === 'ENOENT') {
            throw new ProviderError(
              `\`${bin}\` was not found on PATH. Install Claude Code, or choose another provider.`,
              'claude-cli',
              false,
            )
          }
          throw new ProviderError(
            `claude failed: ${e.message}`,
            'claude-cli',
            true,
            error,
          )
        }
        return parseClaudeResponse<T>(stdout)
      })
    },
  }
}

/** Whether the Claude CLI is available, used to resolve `provider: auto`. */
export async function isClaudeCliAvailable(bin = 'claude'): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}
