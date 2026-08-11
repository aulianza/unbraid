import { describe, it, expect } from 'vitest'
import { parseRemoteUrl, isGitHub } from './remote.js'
import { planCompareUrl, encodeBranch, MAX_URL_LENGTH } from '../engine/pr-url.js'

describe('parseRemoteUrl', () => {
  // Git accepts all of these for the same remote, and people use all of them.
  it.each([
    ['git@github.com:aulianza/unbraid.git', 'github.com', 'aulianza', 'unbraid'],
    ['git@github.com:aulianza/unbraid', 'github.com', 'aulianza', 'unbraid'],
    ['https://github.com/aulianza/unbraid.git', 'github.com', 'aulianza', 'unbraid'],
    ['https://github.com/aulianza/unbraid', 'github.com', 'aulianza', 'unbraid'],
    ['ssh://git@github.com/aulianza/unbraid.git', 'github.com', 'aulianza', 'unbraid'],
    ['ssh://git@github.com:22/aulianza/unbraid.git', 'github.com', 'aulianza', 'unbraid'],
    ['git://github.com/aulianza/unbraid.git', 'github.com', 'aulianza', 'unbraid'],
    ['git@gitlab.com:group/project.git', 'gitlab.com', 'group', 'project'],
    ['https://github.enterprise.co/team/app.git', 'github.enterprise.co', 'team', 'app'],
  ])('%s', (url, host, owner, repo) => {
    expect(parseRemoteUrl(url)).toEqual({ host, owner, repo })
  })

  it('drops embedded credentials', () => {
    const parsed = parseRemoteUrl('https://user:ghp_secret@github.com/a/b.git')
    expect(parsed).toEqual({ host: 'github.com', owner: 'a', repo: 'b' })
    expect(JSON.stringify(parsed)).not.toContain('ghp_secret')
  })

  it('trims surrounding whitespace from git output', () => {
    expect(parseRemoteUrl('  git@github.com:a/b.git\n')).toEqual({
      host: 'github.com',
      owner: 'a',
      repo: 'b',
    })
  })

  it('uses the last two segments of a nested path', () => {
    expect(parseRemoteUrl('https://gitlab.com/group/sub/project.git')).toEqual({
      host: 'gitlab.com',
      owner: 'sub',
      repo: 'project',
    })
  })

  it.each([['', 'empty'], ['/local/path/repo.git', 'local path'], ['nonsense', 'nonsense']])(
    'returns null for %s (%s)',
    (url) => {
      expect(parseRemoteUrl(url)).toBeNull()
    },
  )
})

describe('isGitHub', () => {
  it.each([
    ['github.com', true],
    ['api.github.com', true],
    ['gitlab.com', false],
    ['bitbucket.org', false],
    ['git.mycompany.com', false],
  ])('%s -> %s', (host, expected) => {
    expect(isGitHub({ host, owner: 'a', repo: 'b' })).toBe(expected)
  })
})

describe('encodeBranch', () => {
  it('keeps slashes so the compare path stays intact', () => {
    expect(encodeBranch('feature/PROJ-1')).toBe('feature/PROJ-1')
  })

  it('escapes characters that would end the path', () => {
    expect(encodeBranch('fix/a#b')).toBe('fix/a%23b')
    expect(encodeBranch('fix/a?b')).toBe('fix/a%3Fb')
  })

  it('escapes spaces', () => {
    expect(encodeBranch('my branch')).toBe('my%20branch')
  })
})

describe('planCompareUrl', () => {
  const remote = { host: 'github.com', owner: 'aulianza', repo: 'unbraid' }

  it('builds a compare URL with the fields prefilled', () => {
    const plan = planCompareUrl({
      remote,
      target: 'master',
      head: 'feat/x',
      title: 'feat: add a thing',
      body: 'Because of Y.',
    })

    expect(plan.url).toContain('https://github.com/aulianza/unbraid/compare/master...feat/x')
    expect(plan.url).toContain('expand=1')
    expect(plan.url).toContain('title=feat%3A+add+a+thing')
    expect(plan.bodyIncluded).toBe(true)
  })

  it('encodes newlines and ampersands in the body', () => {
    const plan = planCompareUrl({
      remote,
      target: 'main',
      head: 'x',
      title: 'title',
      body: 'line one\nline two & three',
    })

    expect(plan.url).not.toContain('\n')
    // A raw ampersand would start a new query parameter and truncate the body.
    expect(plan.url).toContain('%26')
  })

  // GitHub answers an over-long URL with a 414, which reaches the user as a
  // broken link rather than "your description was too long".
  it('drops the body rather than producing a URL GitHub rejects', () => {
    const plan = planCompareUrl({
      remote,
      target: 'main',
      head: 'x',
      title: 'feat: big change',
      body: 'x'.repeat(20_000),
    })

    expect(plan.bodyIncluded).toBe(false)
    expect(plan.url.length).toBeLessThan(MAX_URL_LENGTH)
    expect(plan.url).toContain('title=feat')
    expect(plan.bodyBytes).toBe(20_000)
  })

  it('keeps a body that fits', () => {
    const plan = planCompareUrl({
      remote,
      target: 'main',
      head: 'x',
      title: 't',
      body: 'y'.repeat(500),
    })
    expect(plan.bodyIncluded).toBe(true)
  })

  it('handles an empty body', () => {
    const plan = planCompareUrl({ remote, target: 'main', head: 'x', title: 't', body: '' })
    expect(plan.bodyIncluded).toBe(true)
    expect(plan.url).not.toContain('body=')
  })
})
