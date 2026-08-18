import { describe, it, expect } from 'vitest'
import {
  decideNextStep,
  completeOffer,
  parsePrView,
  startOffer,
  renderNextStepSummary,
  type OfferInput,
  type OfferContext,
  type OfferFacts,
} from './pr-offer.js'
import { decidePrMode } from './pr-command.js'
import { stripRemotePrefix } from '../core/git/branch.js'

const openPr = { url: 'https://github.com/o/r/pull/7', number: 7 }

const ready: OfferInput = {
  enabled: true,
  interactive: true,
  unattended: false,
  branch: 'feat/thing',
  base: 'main',
  remoteHost: 'github.com',
  isGitHub: true,
  existingPr: null,
  hasUpstream: true,
  ahead: 2,
}

const reasonFor = (overrides: Partial<OfferInput>): string | undefined => {
  const step = decideNextStep({ ...ready, ...overrides })
  return step.action === 'none' ? step.reason : undefined
}

describe('decideNextStep', () => {
  it('opens a pull request on a feature branch of a GitHub repo', () => {
    expect(decideNextStep(ready)).toEqual({ action: 'open-pr' })
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

  // The base arrives from detection as `origin/main`. Compared unstripped
  // against a checked-out `main` it never matches, and unbraid offers a pull
  // request from the base branch into itself — so the caller must strip it, and
  // the stripped form is what this function is specified against.
  it('recognises the base by its plain name', () => {
    expect(reasonFor({ branch: 'main', base: 'origin/main' })).not.toBe('on-base-branch')
    expect(reasonFor({ branch: 'main', base: 'main' })).toBe('on-base-branch')
  })

  it('stays quiet without a remote', () => {
    expect(reasonFor({ remoteHost: null })).toBe('no-remote')
  })

  it('stays quiet on a host it cannot open a pull request for', () => {
    expect(reasonFor({ remoteHost: 'gitlab.com', isGitHub: false })).toBe('not-github')
  })

  // Being told a pull request exists, and then nothing, leaves the reason you
  // were told — the commits are not on it yet — as the user's problem.
  it('offers a push when a pull request is open and behind', () => {
    expect(decideNextStep({ ...ready, existingPr: openPr, ahead: 3 })).toEqual({
      action: 'push',
      pr: openPr,
    })
  })

  it('offers a push for an open pull request on a never-pushed branch', () => {
    expect(
      decideNextStep({ ...ready, existingPr: openPr, hasUpstream: false, ahead: 0 }),
    ).toMatchObject({ action: 'push' })
  })

  it('stays quiet when the pull request already has every commit', () => {
    expect(reasonFor({ existingPr: openPr, hasUpstream: true, ahead: 0 })).toBe(
      'already-open',
    )
  })

  // Detection fails in a repository with no obvious main branch. That is a
  // reason to let `unbraid pr` ask, not a reason to say nothing.
  it('still offers when the base branch could not be detected', () => {
    expect(decideNextStep({ ...ready, base: null })).toEqual({ action: 'open-pr' })
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

// The checks are `gh` round trips measured at ~4s each on a normal connection.
// Run after the last commit lands, they are silence in a terminal that already
// looks finished — so they start alongside the commits instead.
describe('startOffer', () => {
  const options = {
    git: null as never,
    cwd: '/nowhere',
    enabled: false,
    interactive: true,
    unattended: false,
  }

  it('reports whether it has finished yet', async () => {
    const pending = startOffer(options)
    expect(pending.settled()).toBe(false)

    await pending.result
    expect(pending.settled()).toBe(true)
  })

  it('never rejects, so a failed check cannot fail the commit run', async () => {
    // git is null, so anything that touches it throws.
    const pending = startOffer({ ...options, enabled: true })
    const facts = await pending.result

    expect(facts.skip).toBe('unavailable')
    expect(facts.ghReady).toBe(false)
  })
})

/**
 * "Open a pull request?" does not say from which branch, into which branch, or
 * to whose repository — and the wrong answer to any of those is public.
 */
describe('renderNextStepSummary', () => {
  const plain = { dim: (t: string) => t, bold: (t: string) => t }

  const context = (over: Partial<OfferContext> = {}): OfferContext => ({
    skip: null,
    step: { action: 'open-pr' },
    branch: 'fix/public-web-audit',
    base: 'master',
    existingPr: null,
    remote: { host: 'github.com', owner: 'acme', repo: 'widgets' },
    upstream: { upstream: 'origin/fix/public-web-audit', ahead: 3, behind: 0 },
    ghReady: true,
    ...over,
  })

  it('names the branch, the repository, and the target', () => {
    const summary = renderNextStepSummary(context(), plain)

    expect(summary).toContain('fix/public-web-audit')
    expect(summary).toContain('acme/widgets on github.com')
    expect(summary).toContain('a pull request into master')
    expect(summary).toContain('3 commits to origin/fix/public-web-audit')
  })

  it('says a branch that has never been pushed will be created', () => {
    const summary = renderNextStepSummary(
      context({ upstream: { upstream: null, ahead: 0, behind: 0 } }),
      plain,
    )

    expect(summary).toContain('never been pushed')
  })

  it('names the pull request a push would update', () => {
    const summary = renderNextStepSummary(
      context({ step: { action: 'push', pr: openPr }, existingPr: openPr }),
      plain,
    )

    expect(summary).toContain('pull request #7')
    expect(summary).toContain('https://github.com/o/r/pull/7')
    expect(summary).not.toContain('a pull request into')
  })

  it('says "1 commit", not "1 commits"', () => {
    const summary = renderNextStepSummary(
      context({ upstream: { upstream: 'origin/x', ahead: 1, behind: 0 } }),
      plain,
    )

    expect(summary).toContain('1 commit to')
  })

  it('omits what it does not know rather than printing a blank', () => {
    const summary = renderNextStepSummary(
      context({ remote: null, upstream: null, base: null }),
      plain,
    )

    expect(summary).toContain('fix/public-web-audit')
    expect(summary).not.toContain('undefined')
    expect(summary).not.toContain('null')
  })
})

/**
 * Reported from a real run, on a branch with pull request #786 open:
 *
 *   1 commits created.
 *   Pull request #786 already has these commits.
 *
 * It did not. The facts are gathered before the commits are made — that is what
 * makes the question appear instantly — and the ahead count was read there too,
 * while the branch was still level with its remote. Everything else about the
 * branch survives committing; that one number does not.
 */
describe('measuring the branch after the commits, not before', () => {
  const facts: OfferFacts = {
    skip: null,
    branch: 'fix/public-web-audit',
    base: 'master',
    existingPr: { url: 'https://github.com/acme/storefront/pull/786', number: 786 },
    remote: { host: 'github.com', owner: 'acme', repo: 'storefront' },
    ghReady: true,
  }

  const gate = { enabled: true, interactive: true, unattended: false }

  it('offers the push once the new commit is counted', () => {
    const context = completeOffer(
      facts,
      { upstream: 'origin/fix/public-web-audit', ahead: 1, behind: 0 },
      gate,
    )

    expect(context.step).toMatchObject({ action: 'push' })
  })

  it('stays quiet only when the branch really is level', () => {
    const context = completeOffer(
      facts,
      { upstream: 'origin/fix/public-web-audit', ahead: 0, behind: 0 },
      gate,
    )

    expect(context.step).toEqual({ action: 'none', reason: 'already-open' })
  })

  it('offers the push when the upstream could not be read', () => {
    expect(completeOffer(facts, null, gate).step).toMatchObject({ action: 'push' })
  })

  it('carries an early skip through untouched', () => {
    const context = completeOffer({ ...facts, skip: 'not-github' }, null, gate)
    expect(context.step).toEqual({ action: 'none', reason: 'not-github' })
  })

  it('opens a pull request when none exists, however far ahead', () => {
    const context = completeOffer(
      { ...facts, existingPr: null },
      { upstream: 'origin/fix/public-web-audit', ahead: 4, behind: 0 },
      gate,
    )

    expect(context.step).toEqual({ action: 'open-pr' })
  })
})
