import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCredentials,
  saveCredential,
  lookupKey,
  maskKey,
  credentialsPath,
} from './credentials.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unbraid-creds-'))
  dirs.push(dir)
  return join(dir, 'credentials.json')
}

describe('credentialsPath', () => {
  // Never inside a repository: a repo config is a file people commit, and a
  // key written there gets pushed sooner or later.
  it('lives under the user config directory', () => {
    expect(credentialsPath('/home/u')).toBe('/home/u/.config/unbraid/credentials.json')
  })
})

describe('saveCredential', () => {
  it('stores a key and reads it back', async () => {
    const path = await scratch()
    await saveCredential('ZAI_API_KEY', 'secret-value', path)

    expect(await readCredentials(path)).toEqual({ ZAI_API_KEY: 'secret-value' })
  })

  it('keeps other keys when adding one', async () => {
    const path = await scratch()
    await saveCredential('A_KEY', 'one', path)
    await saveCredential('B_KEY', 'two', path)

    expect(await readCredentials(path)).toEqual({ A_KEY: 'one', B_KEY: 'two' })
  })

  it('replaces an existing key', async () => {
    const path = await scratch()
    await saveCredential('A_KEY', 'old', path)
    await saveCredential('A_KEY', 'new', path)

    expect((await readCredentials(path)).A_KEY).toBe('new')
  })

  // On a shared machine, a world-readable key file is the same as no file.
  it('writes the file readable only by its owner', async () => {
    const path = await scratch()
    await saveCredential('A_KEY', 'v', path)

    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('readCredentials', () => {
  it('returns nothing when the file is absent', async () => {
    expect(await readCredentials(await scratch())).toEqual({})
  })

  it.each([
    ['corrupt json', '{not json'],
    ['an array', '["a"]'],
    ['a bare string', '"hello"'],
  ])('degrades to empty on %s', async (_name, contents) => {
    const path = await scratch()
    await writeFile(path, contents)
    expect(await readCredentials(path)).toEqual({})
  })

  it('drops non-string and empty values', async () => {
    const path = await scratch()
    await writeFile(path, JSON.stringify({ GOOD: 'v', NUM: 3, EMPTY: '', OBJ: {} }))
    expect(await readCredentials(path)).toEqual({ GOOD: 'v' })
  })
})

describe('lookupKey', () => {
  // The environment wins so a key exported for one shell — another account, a
  // CI run — takes effect without editing anything.
  it('prefers the environment over the stored file', () => {
    expect(lookupKey('K', { K: 'from-env' }, { K: 'from-file' })).toBe('from-env')
  })

  it('falls back to the stored file', () => {
    expect(lookupKey('K', {}, { K: 'from-file' })).toBe('from-file')
  })

  it('treats an empty environment value as unset', () => {
    expect(lookupKey('K', { K: '' }, { K: 'from-file' })).toBe('from-file')
  })

  it('returns undefined when neither has it', () => {
    expect(lookupKey('K', {}, {})).toBeUndefined()
  })
})

describe('maskKey', () => {
  it('shows enough to recognise, never enough to use', () => {
    const masked = maskKey('sk-ant-api03-abcdefghijklmnop')
    expect(masked.startsWith('sk-a')).toBe(true)
    expect(masked.endsWith('mnop')).toBe(true)
    expect(masked).not.toContain('api03')
  })

  it('hides a short key entirely', () => {
    expect(maskKey('short')).toBe('•••••')
  })
})
