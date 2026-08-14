import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProviderError,
  withRetry,
  type CompletionRequest,
  type Provider,
} from './types.js'

const execFileAsync = promisify(execFile)

export interface CodexCliOptions {
  bin?: string
  /** Passed to `-m`. Omitted entirely when unset, so codex uses its own default. */
  model?: string
  extraArgs?: string[]
  /** Injected in tests. */
  run?: (bin: string, args: string[]) => Promise<void>
  /** Injected in tests, in place of reading the output file. */
  readOutput?: (path: string) => Promise<string>
}

/**
 * Build the argv for a headless `codex exec` call.
 *
 * Exported separately from the provider because these flags were established
 * empirically against codex-cli 0.142.3 and each one is load-bearing:
 *
 *   -s read-only   unbraid asks codex for a plan, never for actions. Read-only
 *                  removes its ability to run shell commands at all, rather
 *                  than relying on it choosing not to.
 *
 *   --output-schema  codex takes a schema as a FILE, unlike claude, which takes
 *                  it inline. That is why this adapter needs a temp directory.
 *
 *   -o             the conforming JSON is written here. It also appears on
 *                  stdout mixed with progress output, so the file is the only
 *                  clean way to read it.
 *
 *   --skip-git-repo-check  makes the call independent of where it runs.
 */
export function buildCodexArgs(
  schemaPath: string,
  outputPath: string,
  prompt: string,
  options: CodexCliOptions = {},
): string[] {
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--output-schema',
    schemaPath,
    '-o',
    outputPath,
  ]

  if (options.model && options.model !== 'auto') args.push('-m', options.model)
  args.push(...(options.extraArgs ?? []))
  args.push(prompt)

  return args
}

export function parseCodexOutput<T>(contents: string): T {
  const trimmed = contents.trim()
  if (trimmed === '') {
    throw new ProviderError(
      'codex produced no output. The prompt may have been rejected, or the run was interrupted.',
      'codex-cli',
      true,
    )
  }

  try {
    return JSON.parse(trimmed) as T
  } catch {
    throw new ProviderError(
      `codex returned output that was not JSON: ${trimmed.slice(0, 200)}`,
      'codex-cli',
      true,
    )
  }
}

/**
 * Use an installed, already-authenticated Codex CLI.
 *
 * Like the Claude adapter, this costs the user nothing beyond a subscription
 * they already have, and opens no egress path they had not already accepted.
 */
export function createCodexCliProvider(options: CodexCliOptions = {}): Provider {
  const bin = options.bin ?? 'codex'

  const run =
    options.run ??
    (async (binary: string, args: string[]) => {
      const { spawn } = await import('node:child_process')

      /*
       * spawn rather than execFile, for one reason that costs ten minutes to
       * discover: `codex exec` reads stdin when it is not a terminal, and waits
       * there forever. execFile has no way to say "give this process no stdin"
       * — it always attaches a pipe — so the only fix is spawning with stdin
       * ignored.
       */
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
        let stderr = ''

        child.stderr?.on('data', (chunk) => {
          // Keep only the tail; codex writes progress here continuously.
          stderr = (stderr + chunk).slice(-4000)
        })
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`codex exited with ${code}: ${stderr.trim().slice(-300)}`)),
        )
      })
    })

  const readOutput = options.readOutput ?? ((path: string) => readFile(path, 'utf8'))

  return {
    name: 'codex-cli',
    model: options.model && options.model !== 'auto' ? options.model : 'default',
    // Content reaches OpenAI, but through credentials the user already
    // established and a binary they already trust, so the secret guard has no
    // new egress to warn about.
    isRemote: false,

    async complete<T>(request: CompletionRequest): Promise<T> {
      return withRetry(async () => {
        const dir = await mkdtemp(join(tmpdir(), 'unbraid-codex-'))
        const schemaPath = join(dir, 'schema.json')
        const outputPath = join(dir, 'output.json')

        try {
          await writeFile(schemaPath, JSON.stringify(request.schema), 'utf8')

          // codex takes no system prompt, so it is folded into the prompt.
          const prompt = `${request.system}\n\n---\n\n${request.prompt}`
          const args = buildCodexArgs(schemaPath, outputPath, prompt, options)

          try {
            await run(bin, args)
          } catch (error) {
            const e = error as NodeJS.ErrnoException
            if (e.code === 'ENOENT') {
              throw new ProviderError(
                `\`${bin}\` was not found on PATH. Install the Codex CLI, or choose another provider.`,
                'codex-cli',
                false,
              )
            }
            throw new ProviderError(`codex failed: ${e.message}`, 'codex-cli', true, error)
          }

          return parseCodexOutput<T>(await readOutput(outputPath))
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      })
    },
  }
}

/** Whether the Codex CLI is available, used to resolve `provider: auto`. */
export async function isCodexCliAvailable(bin = 'codex'): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}
