import type { Git } from './exec.js'

export interface Remote {
  host: string
  owner: string
  repo: string
}

/**
 * Parse a git remote URL into its host, owner, and repository.
 *
 * Git accepts several shapes for the same remote and people use all of them, so
 * this handles each rather than assuming the common one:
 *
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://user:token@github.com/owner/repo
 *   ssh://git@github.com:22/owner/repo.git
 *   git://github.com/owner/repo.git
 *
 * Returns null when the URL is not a recognisable hosted remote — a local path,
 * for instance — rather than guessing.
 */
export function parseRemoteUrl(url: string): Remote | null {
  const trimmed = url.trim()
  if (trimmed === '') return null

  // scp-like syntax: [user@]host:path. Note this has no "//" after the colon,
  // which is what distinguishes it from ssh://host:port/path.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed)
  if (scp) return fromParts(scp[1]!, scp[2]!)

  try {
    const parsed = new URL(trimmed)
    // `hostname` rather than `host` so a port is dropped, and any embedded
    // credentials are discarded with it.
    return fromParts(parsed.hostname, parsed.pathname)
  } catch {
    return null
  }
}

function fromParts(host: string, path: string): Remote | null {
  const segments = path
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment.length > 0)

  if (segments.length < 2 || host === '') return null

  // Take the last two so nested groups (gitlab.com/group/sub/repo) still yield
  // something sensible for the owner.
  const repo = segments[segments.length - 1]!
  const owner = segments[segments.length - 2]!

  return { host: host.toLowerCase(), owner, repo }
}

export function isGitHub(remote: Remote): boolean {
  return remote.host === 'github.com' || remote.host.endsWith('.github.com')
}

/** Read and parse a remote, defaulting to `origin`. */
export async function readRemote(
  git: Git,
  name = 'origin',
): Promise<Remote | null> {
  const result = await git.runRaw(['remote', 'get-url', name])
  if (result.code !== 0) return null
  return parseRemoteUrl(result.stdout)
}
