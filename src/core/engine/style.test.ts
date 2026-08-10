import { describe, it, expect } from 'vitest'
import { analyzeCommits } from './style.js'

const subjects = (...list: string[]) =>
  list.map((subject) => ({ subject, body: '' }))

describe('analyzeCommits', () => {
  it('detects Conventional Commits', () => {
    const style = analyzeCommits(
      subjects(
        'feat(auth): add refresh tokens',
        'fix(api): handle null user',
        'chore: bump deps',
      ),
    )

    expect(style.format).toBe('conventional')
    expect(style.commonTypes).toContain('feat')
    expect(style.usesScopes).toBe(true)
    expect(style.commonScopes).toContain('auth')
  })

  it('detects gitmoji', () => {
    const style = analyzeCommits(
      subjects('✨ add login', '🐛 fix crash', ':sparkles: add signup'),
    )
    expect(style.format).toBe('gitmoji')
  })

  it('falls back to plain prose', () => {
    const style = analyzeCommits(
      subjects('Add login page', 'Fix the crash on startup', 'Update deps'),
    )
    expect(style.format).toBe('plain')
    expect(style.usesScopes).toBe(false)
  })

  it('requires a majority, not a plurality', () => {
    // Two stray conventional commits should not reclassify a prose history.
    const style = analyzeCommits(
      subjects(
        'Add login page',
        'Fix crash',
        'Update readme',
        'Tidy imports',
        'feat: add signup',
        'fix: null check',
      ),
    )
    expect(style.format).toBe('plain')
  })

  it('reports scopes as unused when only a few commits carry them', () => {
    const style = analyzeCommits(
      subjects(
        'feat: one',
        'feat: two',
        'feat: three',
        'feat: four',
        'fix(api): five',
      ),
    )
    expect(style.usesScopes).toBe(false)
  })

  it('measures how often bodies are written', () => {
    const style = analyzeCommits([
      { subject: 'feat: a', body: 'Because of X.' },
      { subject: 'feat: b', body: '' },
      { subject: 'feat: c', body: 'Because of Y.' },
      { subject: 'feat: d', body: '' },
    ])
    expect(style.bodyRate).toBe(0.5)
  })

  it('reports average title length', () => {
    const style = analyzeCommits(subjects('abcde', 'abcdefghij'))
    expect(style.averageTitleLength).toBe(8)
  })

  it('keeps real subjects as examples for the model', () => {
    const style = analyzeCommits(subjects('feat: one', 'feat: two'))
    expect(style.samples).toEqual(['feat: one', 'feat: two'])
  })

  it('returns a sane default for an empty history', () => {
    const style = analyzeCommits([])
    expect(style.format).toBe('conventional')
    expect(style.samples).toEqual([])
  })

  it('ignores a breaking-change marker when reading the type', () => {
    const style = analyzeCommits(
      subjects('feat(api)!: drop v1', 'fix!: revert', 'feat: add'),
    )
    expect(style.format).toBe('conventional')
    expect(style.commonTypes).toContain('feat')
  })
})
