import { describe, it, expect } from 'vitest'
import { checkSecrets, describeSecretWarning } from './guard.js'
import { describeFileCount } from './render.js'
import type { FileChange, WorkingTreeState } from '../core/engine/types.js'

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({
  path,
  status: 'modified',
  staged: false,
  insertions: 1,
  deletions: 0,
  binary: false,
  ...extra,
})

const patterns = ['.env', '.env.*', '*.pem', '*_rsa', '*.key', '*.p12']

describe('checkSecrets', () => {
  it('blocks credential-shaped files for a remote provider', () => {
    const result = checkSecrets(
      [file('src/a.ts'), file('.env'), file('certs/server.pem')],
      patterns,
      true,
    )

    expect(result.blocked).toBe(true)
    expect(result.matches).toEqual(['.env', 'certs/server.pem'])
  })

  it('stays quiet for a local provider', () => {
    const result = checkSecrets([file('.env')], patterns, false)
    expect(result.blocked).toBe(false)
  })

  it('matches dotfiles in nested directories', () => {
    const result = checkSecrets([file('apps/web/.env.production')], patterns, true)
    expect(result.blocked).toBe(true)
  })

  it('does not flag ordinary source files', () => {
    const result = checkSecrets(
      [file('src/environment.ts'), file('src/keyboard.ts')],
      patterns,
      true,
    )
    expect(result.blocked).toBe(false)
  })

  it('is disabled by an empty pattern list', () => {
    expect(checkSecrets([file('.env')], [], true).blocked).toBe(false)
  })

  it('names the provider in its explanation', () => {
    const text = describeSecretWarning(['.env'], 'anthropic')
    expect(text).toContain('anthropic')
    expect(text).toContain('--no-guard')
  })
})

describe('describeFileCount', () => {
  const state = (files: FileChange[]): WorkingTreeState => ({
    root: '/r',
    head: 'x',
    branch: 'main',
    files,
    operation: 'none',
    detached: false,
  })

  it('counts ordinary files', () => {
    const s = state([file('a.ts'), file('b.ts')])
    expect(describeFileCount(['a.ts', 'b.ts'], s)).toBe('2 files')
  })

  it('uses the singular for one file', () => {
    expect(describeFileCount(['a.ts'], state([file('a.ts')]))).toBe('1 file')
  })

  // The misleading-count bug found while running against a real repository:
  // a collapsed directory is one plan entry but many actual files.
  it('reports the real file count for a collapsed directory', () => {
    const s = state([file('landing/', { collapsed: true, fileCount: 374 })])
    expect(describeFileCount(['landing/'], s)).toBe('374 files in 1 entry')
  })

  it('mixes collapsed directories and plain files', () => {
    const s = state([
      file('a.ts'),
      file('landing/', { collapsed: true, fileCount: 10 }),
    ])
    expect(describeFileCount(['a.ts', 'landing/'], s)).toBe('11 files in 2 entries')
  })
})
