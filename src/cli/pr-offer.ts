import { spawn } from 'node:child_process'
import type { Git } from '../core/git/exec.js'
import {
  currentBranch,
  resolveBaseBranch,
  remoteNames,
  stripRemotePrefix,
} from '../core/git/branch.js'
import { readRemote, isGitHub } from '../core/git/remote.js'

/**
 * Whether to offer a pull request once the commits have landed.
 *
 * The commits are the work; the pull request is what makes them visible to
 * anyone else. Making the user remember a second command — and re-derive the
 * base branch, and push — is a seam in a flow that has no reason to have one.
 *
 * The decision is a pure function so every reason to stay quiet is testable.
 * Staying quiet matters more than offering: an unwanted prompt after a
 * successful commit is the kind of thing people disable the tool over.
 */

export type SkipReason =
  | 'disabled'
  | 'unattended'
  | 'not-interactive'
  | 'detached'
  | 'on-base-branch'
  | 'no-remote'
  | 'not-github'
  | 'already-open'

export type OfferDecision =
  | { offer: true }
  | { offer: false; reason: SkipReason }

export interface OfferInput {
  /** config.pr.offerAfterCommit */
  enabled: boolean
  /** stdin is a terminal, so there is somebody to answer. */
  interactive: boolean
  /** --yes or execute.autoconfirm: the user asked for no questions. */
  unattended: boolean
  /** Null when HEAD is detached. */
  branch: string | null
  /** The branch a pull request would target. */
  base: string | null
  /** Null when there is no origin remote. */
  remoteHost: string | null
  isGitHub: boolean
  /** URL of a pull request that already exists for this branch. */
  existingPr: string | null
}

export function shouldOfferPr(input: OfferInput): OfferDecision {
  if (!input.enabled) return { offer: false, reason: 'disabled' }
  if (input.unattended) return { offer: false, reason: 'unattended' }
  if (!input.interactive) return { offer: false, reason: 'not-interactive' }
  if (input.branch === null) return { offer: false, reason: 'detached' }

  // Nothing to open: a pull request from a branch into itself is not a thing,
  // and committing straight to main is a normal way to work.
  if (input.base !== null && input.branch === input.base) {
    return { offer: false, reason: 'on-base-branch' }
  }

  if (input.remoteHost === null) return { offer: false, reason: 'no-remote' }
  if (!input.isGitHub) return { offer: false, reason: 'not-github' }

  // Already open: the new commits appear on it as soon as they are pushed, so
  // there is nothing to create.
  if (input.existingPr !== null) return { offer: false, reason: 'already-open' }

  return { offer: true }
}

/** Run a command and return its stdout, or null if it fails in any way. */
async function tryRun(
  command: string,
  args: string[],
  cwd: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    // A missing binary arrives here rather than as a non-zero exit.
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? out : null))
  })
}

/** Is the GitHub CLI installed and logged in? */
export async function isGhReady(cwd: string): Promise<boolean> {
  return (await tryRun('gh', ['auth', 'status'], cwd)) !== null
}

export interface ExistingPr {
  url: string
  number: number
}

/**
 * Find an open pull request for a branch.
 *
 * Uses the GitHub CLI because it already holds the user's credentials; an
 * unauthenticated API call would be rate-limited and would fail outright on a
 * private repository.
 *
 * Returns null both for "no pull request" and for "cannot tell" — the caller
 * treats them the same. Being wrong that way offers a pull request that turns
 * out to exist, which GitHub itself catches by showing the existing one.
 */
export async function findOpenPr(
  cwd: string,
  branch: string,
): Promise<ExistingPr | null> {
  const out = await tryRun(
    'gh',
    ['pr', 'view', branch, '--json', 'url,number,state'],
    cwd,
  )
  if (out === null) return null

  return parsePrView(out)
}

/** Split out so the shapes gh returns can be tested without gh installed. */
export function parsePrView(json: string): ExistingPr | null {
  try {
    const parsed = JSON.parse(json) as {
      url?: unknown
      number?: unknown
      state?: unknown
    }

    // A merged or closed pull request is not one to reuse: new commits on the
    // branch need a new pull request.
    if (parsed.state !== 'OPEN') return null
    if (typeof parsed.url !== 'string' || typeof parsed.number !== 'number') {
      return null
    }

    return { url: parsed.url, number: parsed.number }
  } catch {
    return null
  }
}

export interface GatherOptions {
  git: Git
  cwd: string
  enabled: boolean
  interactive: boolean
  unattended: boolean
  /** Configured base branch, if the user pinned one. */
  target?: string | undefined
}

export interface OfferContext {
  decision: OfferDecision
  branch: string | null
  base: string | null
  existingPr: ExistingPr | null
}

/**
 * Collect what the decision needs, skipping work once the answer is settled.
 *
 * Ordered cheapest-first on purpose: the `gh` calls are the slow part, and
 * there is no reason to spend them on a run that was never going to offer
 * anything — which is most runs, since most repositories are not on GitHub or
 * the user passed --yes.
 */
export async function gatherOffer(options: GatherOptions): Promise<OfferContext> {
  const bail = (reason: SkipReason): OfferContext => ({
    decision: { offer: false, reason },
    branch: null,
    base: null,
    existingPr: null,
  })

  if (!options.enabled) return bail('disabled')
  if (options.unattended) return bail('unattended')
  if (!options.interactive) return bail('not-interactive')

  const branch = await currentBranch(options.git)
  if (branch === null) return bail('detached')

  const remote = await readRemote(options.git)
  if (!remote) return { ...bail('no-remote'), branch }
  if (!isGitHub(remote)) return { ...bail('not-github'), branch }

  // Detection can fail in a repository with no obvious main branch. That is not
  // a reason to stay silent — `unbraid pr` asks the same question later.
  let base: string | null = null
  try {
    // Stripped, because both uses here are about the branch as a name: what to
    // say in the question, and whether it is the branch already checked out.
    // Comparing `master` against an unstripped `origin/master` never matches,
    // which would offer a pull request from the base branch into itself.
    base = stripRemotePrefix(
      await resolveBaseBranch(options.git, options.target),
      await remoteNames(options.git),
    )
  } catch {
    base = null
  }

  const existingPr = await findOpenPr(options.cwd, branch)

  return {
    decision: shouldOfferPr({
      enabled: options.enabled,
      interactive: options.interactive,
      unattended: options.unattended,
      branch,
      base,
      remoteHost: remote.host,
      isGitHub: true,
      existingPr: existingPr?.url ?? null,
    }),
    branch,
    base,
    existingPr,
  }
}
