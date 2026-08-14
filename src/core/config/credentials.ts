import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * API keys, stored outside any repository.
 *
 * Deliberately not part of `.unbraidrc.yaml`. A repository config is a file
 * people commit — that is the whole point of it — so a key written there gets
 * pushed sooner or later, and a leaked key is a worse outcome than any
 * convenience this saves. Keys live in one file under the user's config
 * directory, readable only by them.
 *
 * The config still refers to keys by environment variable name. This file is
 * only a fallback for when that variable is not set, so nothing changes for
 * anyone already exporting one.
 */

export type Credentials = Record<string, string>

export function credentialsPath(home = homedir()): string {
  return join(home, '.config', 'unbraid', 'credentials.json')
}

export async function readCredentials(
  path = credentialsPath(),
): Promise<Credentials> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    // Keep only string values; a malformed file should degrade to "no key
    // stored" rather than putting an object where a key is expected.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === 'string' && value.length > 0,
      ),
    ) as Credentials
  } catch {
    return {}
  }
}

/**
 * Store one key, preserving the others.
 *
 * The file is written with mode 0600 and the directory with 0700, so it is
 * unreadable by other users on a shared machine. chmod runs after the write
 * because the initial mode is subject to the process umask.
 */
export async function saveCredential(
  name: string,
  value: string,
  path = credentialsPath(),
): Promise<void> {
  const existing = await readCredentials(path)
  const next = { ...existing, [name]: value }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * Look a key up in the environment first, then in the stored file.
 *
 * Environment wins so that a key exported for one shell — a different account,
 * a CI run — takes effect without editing anything.
 */
export function lookupKey(
  name: string,
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): string | undefined {
  const fromEnv = env[name]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return credentials[name]
}

/** Show enough of a key to recognise it, never enough to use it. */
export function maskKey(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(value.length - 8, 20))}${value.slice(-4)}`
}
