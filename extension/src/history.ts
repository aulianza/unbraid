import type { Git } from 'unbraid'

export interface RecentCommit {
  sha: string
  short: string
  subject: string
  /** Relative, as git renders it: "2 hours ago". */
  when: string
  author: string
}

export interface BranchChoice {
  name: string
  current: boolean
  /** Present for remote-only branches, which need creating locally on checkout. */
  remote: boolean
}

/**
 * Recent commits on the current branch.
 *
 * Read with `%x1f` field separators and `%x1e` record separators rather than
 * anything friendlier, because commit subjects routinely contain every
 * punctuation mark a simpler format would rely on.
 */
export async function recentCommits(git: Git, limit = 15): Promise<RecentCommit[]> {
  const result = await git.runRaw([
    'log',
    `-n${limit}`,
    '--format=%H%x1f%h%x1f%s%x1f%cr%x1f%an%x1e',
  ])
  if (result.code !== 0) return []

  return result.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = '', short = '', subject = '', when = '', author = ''] =
        record.split('\x1f')
      return { sha, short, subject, when, author }
    })
}

/**
 * Local branches first, then remote-only ones.
 *
 * A remote branch with no local counterpart is a legitimate checkout target —
 * git creates the local branch on the way — so omitting them would make the
 * picker useless right after a clone or a colleague's push.
 */
export async function listBranchChoices(git: Git): Promise<BranchChoice[]> {
  const current = await git.runRaw(['symbolic-ref', '--short', '--quiet', 'HEAD'])
  const currentName = current.code === 0 ? current.stdout.trim() : null

  const local = await readRefs(git, 'refs/heads')
  const remote = await readRefs(git, 'refs/remotes')

  const localNames = new Set(local)
  const remoteOnly = remote
    // origin/HEAD is a symbolic pointer, not somewhere to check out.
    .filter((ref) => !ref.endsWith('/HEAD'))
    .map((ref) => ref.replace(/^[^/]+\//, ''))
    .filter((name) => !localNames.has(name))

  return [
    ...local.map((name) => ({ name, current: name === currentName, remote: false })),
    ...[...new Set(remoteOnly)].map((name) => ({ name, current: false, remote: true })),
  ]
}

async function readRefs(git: Git, namespace: string): Promise<string[]> {
  const result = await git.runRaw([
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    namespace,
  ])
  if (result.code !== 0) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

export async function checkout(git: Git, branch: string): Promise<void> {
  await git.run(['checkout', branch])
}

export async function createBranch(git: Git, name: string): Promise<void> {
  await git.run(['checkout', '-b', name])
}

/**
 * Whether a name is usable as a branch.
 *
 * Checked before calling git so the error names the problem, rather than
 * surfacing git's own message about ref format rules.
 */
export function validateBranchName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name.'
  if (/\s/.test(trimmed)) return 'Branch names cannot contain spaces.'
  if (/^[-.]|[-.]$/.test(trimmed)) return 'Branch names cannot start or end with - or .'
  if (/\.\.|[~^:?*[\\]|@\{/.test(trimmed)) {
    return 'Branch names cannot contain .. ~ ^ : ? * [ \\ or @{'
  }
  if (trimmed.endsWith('.lock')) return 'Branch names cannot end with .lock'
  return null
}
