import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isNewer } from '../core/version.js'

const REGISTRY = 'https://registry.npmjs.org/unbraid/latest'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2000

export interface CacheEntry {
  /** Milliseconds since epoch of the last successful check. */
  checkedAt: number
  latest: string
}

export interface UpdateCheckOptions {
  currentVersion: string
  /** Skip everything. Set for local providers, CI, npx, and opt-outs. */
  disabled: boolean
  now?: () => number
  cachePath?: string
  fetchImpl?: typeof fetch
  binPath?: string
}

/**
 * How the user installed unbraid, inferred from where the running file lives.
 *
 * Printing `npm i -g` to someone who installed with bun sends them to the wrong
 * package manager, and the update silently never happens.
 */
export type InstallMethod = 'npx' | 'bun' | 'pnpm' | 'npm'

export function detectInstallMethod(binPath: string): InstallMethod {
  if (binPath.includes('_npx')) return 'npx'
  if (binPath.includes('/.bun/') || binPath.includes('\\.bun\\')) return 'bun'
  if (binPath.includes('pnpm')) return 'pnpm'
  return 'npm'
}

export function upgradeCommand(method: InstallMethod): string {
  switch (method) {
    case 'bun':
      return 'bun add -g unbraid'
    case 'pnpm':
      return 'pnpm add -g unbraid'
    default:
      return 'npm i -g unbraid@latest'
  }
}

export function defaultCachePath(home = homedir()): string {
  return join(home, '.cache', 'unbraid', 'update.json')
}

/**
 * Decide whether to tell the user about a new version, and refresh the cache.
 *
 * Returns the message to print, or null. The refresh is deliberately not
 * awaited: an update notice is a nicety, and no nicety is worth adding latency
 * to every run. The consequence is that a release is noticed on the second run
 * after it ships rather than the first, which is the standard trade.
 */
export async function checkForUpdate(
  options: UpdateCheckOptions,
): Promise<string | null> {
  if (options.disabled) return null

  const binPath = options.binPath ?? process.argv[1] ?? ''
  const method = detectInstallMethod(binPath)
  // npx already fetches the newest version on every run, so telling an npx user
  // to update is pure noise.
  if (method === 'npx') return null

  const now = options.now ?? Date.now
  const cachePath = options.cachePath ?? defaultCachePath()
  const cache = await readCache(cachePath)

  if (now() - (cache?.checkedAt ?? 0) > CHECK_INTERVAL_MS) {
    void refresh(cachePath, options.fetchImpl ?? fetch, now)
  }

  if (!cache || !isNewer(cache.latest, options.currentVersion)) return null

  return [
    `Update available  ${options.currentVersion} → ${cache.latest}`,
    upgradeCommand(method),
  ].join('\n')
}

async function readCache(path: string): Promise<CacheEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CacheEntry>
    if (typeof parsed.latest !== 'string' || typeof parsed.checkedAt !== 'number') {
      return null
    }
    return { latest: parsed.latest, checkedAt: parsed.checkedAt }
  } catch {
    // Absent, unreadable, or corrupt. All mean the same thing: check again.
    return null
  }
}

/**
 * Fetch the latest version and cache it. Failures are silent by design — a
 * background convenience must never produce an error the user has to read.
 */
async function refresh(
  cachePath: string,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<void> {
  try {
    const response = await fetchImpl(REGISTRY, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    if (!response.ok) return

    const payload = (await response.json()) as { version?: unknown }
    if (typeof payload.version !== 'string') return

    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(
      cachePath,
      JSON.stringify({ checkedAt: now(), latest: payload.version }),
      'utf8',
    )
  } catch {
    // Offline, timed out, rate limited, read-only home directory. None of these
    // are the user's problem right now.
  }
}
