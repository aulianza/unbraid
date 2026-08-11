import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkForUpdate,
  detectInstallMethod,
  upgradeCommand,
  defaultCachePath,
} from './update-check.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function scratchCache(entry?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unbraid-update-'))
  dirs.push(dir)
  const path = join(dir, 'update.json')
  if (entry !== undefined) {
    await mkdir(dir, { recursive: true })
    await writeFile(path, typeof entry === 'string' ? entry : JSON.stringify(entry))
  }
  return path
}

/** A fetch that must never be called, for the paths that should stay offline. */
const noFetch: typeof fetch = () => {
  throw new Error('network was used when it should not have been')
}

const fetchReturning = (version: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

const NOW = 1_000_000_000_000
const fresh = (latest: string) => ({ checkedAt: NOW - 1000, latest })
const stale = (latest: string) => ({ checkedAt: NOW - 48 * 60 * 60 * 1000, latest })

describe('detectInstallMethod', () => {
  it.each([
    ['/Users/x/.npm/_npx/abc/node_modules/.bin/unbraid', 'npx'],
    ['/Users/x/.bun/install/global/node_modules/unbraid/dist/cli/index.js', 'bun'],
    ['/Users/x/Library/pnpm/global/5/node_modules/unbraid/dist/cli/index.js', 'pnpm'],
    ['/usr/local/lib/node_modules/unbraid/dist/cli/index.js', 'npm'],
  ])('%s -> %s', (path, expected) => {
    expect(detectInstallMethod(path)).toBe(expected)
  })
})

describe('upgradeCommand', () => {
  // Telling a bun user to run `npm i -g` sends them to the wrong package
  // manager, and the update silently never happens.
  it.each([
    ['bun', 'bun add -g unbraid'],
    ['pnpm', 'pnpm add -g unbraid'],
    ['npm', 'npm i -g unbraid@latest'],
  ] as const)('%s -> %s', (method, expected) => {
    expect(upgradeCommand(method)).toBe(expected)
  })
})

describe('checkForUpdate', () => {
  const base = {
    currentVersion: '0.7.0',
    disabled: false,
    now: () => NOW,
    binPath: '/usr/local/lib/node_modules/unbraid/dist/cli/index.js',
  }

  it('reports a newer version from a fresh cache', async () => {
    const message = await checkForUpdate({
      ...base,
      cachePath: await scratchCache(fresh('0.8.0')),
      fetchImpl: noFetch,
    })

    expect(message).toContain('0.7.0 → 0.8.0')
    expect(message).toContain('npm i -g unbraid@latest')
  })

  it('says nothing when already current', async () => {
    expect(
      await checkForUpdate({
        ...base,
        cachePath: await scratchCache(fresh('0.7.0')),
        fetchImpl: noFetch,
      }),
    ).toBeNull()
  })

  // A rollback on the registry must not prompt a "downgrade available".
  it('says nothing when the registry is behind', async () => {
    expect(
      await checkForUpdate({
        ...base,
        cachePath: await scratchCache(fresh('0.6.0')),
        fetchImpl: noFetch,
      }),
    ).toBeNull()
  })

  it('says nothing on the very first run, with no cache yet', async () => {
    expect(
      await checkForUpdate({
        ...base,
        cachePath: await scratchCache(),
        fetchImpl: fetchReturning('0.9.0'),
      }),
    ).toBeNull()
  })

  it('touches nothing at all when disabled', async () => {
    expect(
      await checkForUpdate({
        ...base,
        disabled: true,
        cachePath: await scratchCache(fresh('9.9.9')),
        fetchImpl: noFetch,
      }),
    ).toBeNull()
  })

  // npx fetches the newest version every run, so a notice would be noise.
  it('says nothing when run through npx', async () => {
    expect(
      await checkForUpdate({
        ...base,
        binPath: '/Users/x/.npm/_npx/abc/node_modules/.bin/unbraid',
        cachePath: await scratchCache(fresh('9.9.9')),
        fetchImpl: noFetch,
      }),
    ).toBeNull()
  })

  it('still reports from a stale cache while refreshing it', async () => {
    const cachePath = await scratchCache(stale('0.8.0'))

    const message = await checkForUpdate({
      ...base,
      cachePath,
      fetchImpl: fetchReturning('0.9.0'),
    })

    // The cached answer is used immediately; the newer one lands next run.
    expect(message).toContain('0.7.0 → 0.8.0')

    await new Promise((resolve) => setTimeout(resolve, 30))
    const written = JSON.parse(await readFile(cachePath, 'utf8'))
    expect(written.latest).toBe('0.9.0')
    expect(written.checkedAt).toBe(NOW)
  })

  it('does not refresh while the cache is fresh', async () => {
    await checkForUpdate({
      ...base,
      cachePath: await scratchCache(fresh('0.8.0')),
      fetchImpl: noFetch, // would throw if called
    })
  })

  it.each([
    ['corrupt json', '{not json'],
    ['wrong shape', JSON.stringify({ hello: 'world' })],
    ['missing timestamp', JSON.stringify({ latest: '9.9.9' })],
  ])('survives a %s cache file', async (_name, contents) => {
    expect(
      await checkForUpdate({
        ...base,
        cachePath: await scratchCache(contents),
        fetchImpl: fetchReturning('0.9.0'),
      }),
    ).toBeNull()
  })

  // An update notice is a convenience. It must never surface an error.
  it('stays silent when the network fails', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    }

    await expect(
      checkForUpdate({
        ...base,
        cachePath: await scratchCache(),
        fetchImpl: failing,
      }),
    ).resolves.toBeNull()
  })

  it('stays silent on a non-200 response', async () => {
    const rateLimited: typeof fetch = (async () =>
      new Response('slow down', { status: 429 })) as unknown as typeof fetch

    await expect(
      checkForUpdate({ ...base, cachePath: await scratchCache(), fetchImpl: rateLimited }),
    ).resolves.toBeNull()
  })
})

describe('defaultCachePath', () => {
  it('lives under the user cache directory, not the config directory', () => {
    // Config is something the user edits; this is disposable state.
    expect(defaultCachePath('/home/u')).toBe('/home/u/.cache/unbraid/update.json')
  })
})
