import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A git invocation that exited non-zero. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * A thin, typed wrapper around the `git` binary scoped to one directory.
 *
 * Every git call in unbraid goes through here so that argument handling,
 * buffer limits, and error shape are consistent. Note that arguments are passed
 * as an array to `execFile` — no shell is involved, so paths containing spaces,
 * quotes, or semicolons are safe.
 */
export interface Git {
  readonly cwd: string
  /** Run git, throwing `GitError` on a non-zero exit. */
  run(args: string[]): Promise<string>
  /** Run git, returning the exit code instead of throwing. */
  runRaw(args: string[]): Promise<GitResult>
}

export function createGit(cwd: string): Git {
  const runRaw = async (args: string[]): Promise<GitResult> => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, {
        cwd,
        // Diffs of a large changeset comfortably exceed the 1MB default.
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      })
      return { stdout, stderr, code: 0 }
    } catch (error) {
      const e = error as NodeJS.ErrnoException & {
        stdout?: string
        stderr?: string
        code?: number | string
      }
      if (e.code === 'ENOENT') {
        throw new GitError(
          'git is not installed or not on PATH',
          args,
          127,
          e.message,
        )
      }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message,
        code: typeof e.code === 'number' ? e.code : 1,
      }
    }
  }

  return {
    cwd,
    runRaw,
    async run(args) {
      const { stdout, stderr, code } = await runRaw(args)
      if (code !== 0) {
        throw new GitError(
          `git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`,
          args,
          code,
          stderr,
        )
      }
      return stdout
    },
  }
}

/** Split NUL-delimited git output, discarding the trailing empty element. */
export function splitNul(output: string): string[] {
  const parts = output.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}
