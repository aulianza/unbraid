import { describe, it, expect } from 'vitest'
import { shouldOfferPr, parsePrView, type OfferInput } from './pr-offer.js'
import { decidePrMode } from './pr-command.js'
import { stripRemotePrefix } from '../core/git/branch.js'

const ready: OfferInput = {
  enabled: true,
  interactive: true,
  unattended: false,
  branch: 'feat/thing',
  base: 'main',
  remoteHost: 'github.com',
  isGitHub: true,
  existingPr: null,
}

const reasonFor = (overrides: Partial<OfferInput>): string | undefined => {
  const decision = shouldOfferPr({ ...ready, ...overrides })
  return decision.offer ? undefined : decision.reason
}

describe('shouldOfferPr', () => {
  it('offers on a feature branch of a GitHub repo', () => {
    expect(shouldOfferPr(ready)).toEqual({ offer: true })
  })

  it('respects the config switch', () => {
    expect(reasonFor({ enabled: false })).toBe('disabled')
  })

  // --yes means "do not ask me anything". A prompt appearing after it would be
  // the tool ignoring the one instruction it was given.
  it('stays quiet when the user asked for no questions', () => {
    expect(reasonFor({ unattended: true })).toBe('unattended')
  })

  it('stays quiet with nobody to answer', () => {
    expect(reasonFor({ interactive: false })).toBe('not-interactive')
  })

  it('stays quiet on a detached HEAD', () => {
    expect(reasonFor({ branch: null })).toBe('detached')
  })

  // Committing straight to main is a normal way to work, and a pull request
  // from a branch into itself is not a thing.
  it('stays quiet on the base branch itself', () => {
    expect(reasonFor({ branch: 'main', base: 'main' })).toBe('on-base-branch')
  })

  it('stays quiet without a remote', () => {
    expect(reasonFor({ remoteHost: null })).toBe('no-remote')
  })

  it('stays quiet on a host it cannot open a pull request for', () => {
    expect(reasonFor({ remoteHost: 'gitlab.com', isGitHub: false })).toBe('not-github')
  })

  it('stays quiet when a pull request is already open', () => {
    expect(reasonFor({ existingPr: 'https://github.com/o/r/pull/7' })).toBe('already-open')
  })

  // Detection fails in a repository with no obvious main branch. That is a
  // reason to let `unbraid pr` ask, not a reason to say nothing.
  it('still offers when the base branch could not be detected', () => {
    expect(shouldOfferPr({ ...ready, base: null })).toEqual({ offer: true })
  })

  // Checked in order so the cheapest, most emphatic "no" wins: someone who
  // turned the feature off should not have `gh` run on their behalf.
  it('reports the config switch ahead of any other reason', () => {
    expect(
      reasonFor({ enabled: false, interactive: false, branch: null, remoteHost: null }),
    ).toBe('disabled')
  })
})

describe('parsePrView', () => {
  it('reads an open pull request', () => {
    expect(
      parsePrView('{"url":"https://github.com/o/r/pull/7","number":7,"state":"OPEN"}'),
    ).toEqual({ url: 'https://github.com/o/r/pull/7', number: 7 })
  })

  // A merged or closed pull request cannot take new commits, so the branch
  // needs a new one — treat it as though none existed.
  it('ignores a merged pull request', () => {
    expect(
      parsePrView('{"url":"https://github.com/o/r/pull/7","number":7,"state":"MERGED"}'),
    ).toBeNull()
    expect(
      parsePrView('{"url":"https://github.com/o/r/pull/7","number":7,"state":"CLOSED"}'),
    ).toBeNull()
  })

  it('survives output that is not the JSON it expected', () => {
    expect(parsePrView('gh: command not found')).toBeNull()
    expect(parsePrView('')).toBeNull()
    expect(parsePrView('{"state":"OPEN"}')).toBeNull()
    expect(parsePrView('{"url":7,"number":"7","state":"OPEN"}')).toBeNull()
  })
})

describe('decidePrMode', () => {
  // Printing was the old default, which made the useful path a flag you had to
  // know existed. Running the command is now the same as wanting the result.
  it('opens the browser by default', () => {
    expect(decidePrMode({}, true)).toBe('web')
  })

  it('prints for --draft', () => {
    expect(decidePrMode({ draft: true }, true)).toBe('draft')
  })

  it('uses the GitHub CLI for --open', () => {
    expect(decidePrMode({ open: true }, true)).toBe('gh')
  })

  it('still honours an explicit --web', () => {
    expect(decidePrMode({ web: true }, true)).toBe('web')
  })

  // Someone capturing the text does not want a browser tab as well.
  it('prints when writing to a file', () => {
    expect(decidePrMode({ out: 'pr.md' }, true)).toBe('draft')
  })

  // A browser opening out of a CI job or a shell pipeline is never wanted.
  it('prints when there is no terminal', () => {
    expect(decidePrMode({}, false)).toBe('draft')
  })

  it('opens even without a terminal when asked outright', () => {
    expect(decidePrMode({ web: true }, false)).toBe('web')
    expect(decidePrMode({ open: true }, false)).toBe('gh')
  })

  it('prefers --open over --draft, the more specific instruction', () => {
    expect(decidePrMode({ open: true, draft: true }, true)).toBe('gh')
  })
})

// Base detection resolves to origin/master because that is the ref worth
// diffing against. GitHub has no branch by that name: a compare URL built from
// it opened `compare/origin/master...branch`, which is not a valid comparison.
describe('stripRemotePrefix', () => {
  it('drops the remote a tracking ref is named for', () => {
    expect(stripRemotePrefix('origin/master', ['origin'])).toBe('master')
  })

  it('handles a remote that is not called origin', () => {
    expect(stripRemotePrefix('upstream/main', ['origin', 'upstream'])).toBe('main')
  })

  it('leaves a plain branch name alone', () => {
    expect(stripRemotePrefix('master', ['origin'])).toBe('master')
  })

  // Slashes are ordinary in branch names, and only the remote prefix goes.
  it('keeps the rest of a slashed branch name', () => {
    expect(stripRemotePrefix('origin/release/2.0', ['origin'])).toBe('release/2.0')
    expect(stripRemotePrefix('feat/origin/thing', ['origin'])).toBe('feat/origin/thing')
  })

  it('changes nothing when there are no remotes', () => {
    expect(stripRemotePrefix('origin/master', [])).toBe('origin/master')
  })
})
