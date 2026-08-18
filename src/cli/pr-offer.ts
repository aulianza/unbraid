import { spawn } from 'node:child_process'
import type { Git } from '../core/git/exec.js'
import {
  currentBranch,
  resolveBaseBranch,
  remoteNames,
  stripRemotePrefix,
  type UpstreamStatus,
} from '../core/git/branch.js'
import { readRemote, isGitHub, type Remote } from '../core/git/remote.js'

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
  /** Something went wrong working it out. Never a reason to fail the run. */
  | 'unavailable'

export type NextStep =
  /** No pull request for this branch yet. Write one and open it. */
  | { action: 'open-pr' }
  /** One is already open. The commits reach it by being pushed. */
  | { action: 'push'; pr: ExistingPr }
  | { action: 'none'; reason: SkipReason }

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
  /** A pull request that already exists for this branch. */
  existingPr: ExistingPr | null
  /** False when the branch has never been pushed. */
  hasUpstream: boolean
  /** Local commits the remote does not have. */
  ahead: number
}

/**
 * What to offer once the commits exist.
 *
 * An open pull request used to end the conversation: unbraid printed the link
 * and stopped, leaving the reason you were told about it — the commits are not
 * on it yet — as your problem. Pushing is the step that finishes the job, so it
 * is the step to offer.
 */
export function decideNextStep(input: OfferInput): NextStep {
  const none = (reason: SkipReason): NextStep => ({ action: 'none', reason })

  if (!input.enabled) return none('disabled')
  if (input.unattended) return none('unattended')
  if (!input.interactive) return none('not-interactive')
  if (input.branch === null) return none('detached')

  // Nothing to open: a pull request from a branch into itself is not a thing,
  // and committing straight to main is a normal way to work.
  if (input.base !== null && input.branch === input.base) {
    return none('on-base-branch')
  }

  if (input.remoteHost === null) return none('no-remote')
  if (!input.isGitHub) return none('not-github')

  if (input.existingPr !== null) {
    // Nothing to send: the pull request already has every commit.
    if (input.hasUpstream && input.ahead === 0) return none('already-open')
    return { action: 'push', pr: input.existingPr }
  }

  return { action: 'open-pr' }
}

/**
 * Run a command and return its stdout, or null if it fails in any way.
 *
 * Bounded, because every caller here is optional: this decides whether to ask a
 * question, and no question is worth making somebody wait on a stalled network
 * call. Past the deadline the answer is "could not tell", which the callers
 * already handle.
 */
async function tryRun(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    let done = false

    const finish = (value: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    // Do not hold the process open on this timer alone.
    timer.unref?.()

    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    // A missing binary arrives here rather than as a non-zero exit.
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
  })
}

/**
 * Is the GitHub CLI installed and holding credentials?
 *
 * `gh auth token` rather than `gh auth status`: status makes a round trip to
 * GitHub to validate the token, which measured at 3.6 seconds against 0.07 for
 * reading it locally. This only picks between creating the pull request with
 * `gh` and opening a prefilled page, and if the token turns out to be stale the
 * `gh` path reports that itself.
 *
 * The token is never read, only its presence.
 */
export async function isGhReady(cwd: string): Promise<boolean> {
  return (await tryRun('gh', ['auth', 'token'], cwd)) !== null
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

/**
 * What can be worked out before the commits are made.
 *
 * Everything here is unchanged by committing — which branch you are on, where
 * it points, whether a pull request exists — so it is safe to gather early and
 * overlap with the commits themselves.
 *
 * How far ahead of the remote the branch is deliberately is NOT here. That is
 * the one fact the commits change, and reading it early is how unbraid came to
 * announce that a pull request already had commits that did not exist yet.
 */
export interface OfferFacts {
  /** Set when the answer is already "ask nothing". */
  skip: SkipReason | null
  branch: string | null
  base: string | null
  existingPr: ExistingPr | null
  remote: Remote | null
  /** Whether `gh` can create the pull request outright. */
  ghReady: boolean
}

export interface OfferContext extends OfferFacts {
  step: NextStep
  upstream: UpstreamStatus | null
}

export interface OfferGate {
  enabled: boolean
  interactive: boolean
  unattended: boolean
}

/**
 * Decide, once the commits exist and the branch has been measured against its
 * remote.
 */
export function completeOffer(
  facts: OfferFacts,
  upstream: UpstreamStatus | null,
  gate: OfferGate,
): OfferContext {
  if (facts.skip !== null) {
    return { ...facts, upstream, step: { action: 'none', reason: facts.skip } }
  }

  return {
    ...facts,
    upstream,
    step: decideNextStep({
      ...gate,
      branch: facts.branch,
      base: facts.base,
      remoteHost: facts.remote?.host ?? null,
      isGitHub: facts.remote !== null,
      existingPr: facts.existingPr,
      // A branch whose upstream could not be read is treated as unpushed: the
      // cost of offering a push that turns out to be unnecessary is one extra
      // question, against silently withholding the only step that remains.
      hasUpstream: upstream?.upstream != null,
      ahead: upstream?.ahead ?? 0,
    }),
  }
}

/**
 * Collect what the decision needs, skipping work once the answer is settled.
 *
 * Ordered cheapest-first on purpose: the `gh` calls are the slow part, and
 * there is no reason to spend them on a run that was never going to offer
 * anything — which is most runs, since most repositories are not on GitHub or
 * the user passed --yes.
 */
export async function gatherOffer(options: GatherOptions): Promise<OfferFacts> {
  const bail = (reason: SkipReason): OfferFacts => ({
    skip: reason,
    branch: null,
    base: null,
    existingPr: null,
    remote: null,
    ghReady: false,
  })

  if (!options.enabled) return bail('disabled')
  if (options.unattended) return bail('unattended')
  if (!options.interactive) return bail('not-interactive')

  const branch = await currentBranch(options.git)
  if (branch === null) return bail('detached')

  const remote = await readRemote(options.git)
  if (!remote) return { ...bail('no-remote'), branch }
  if (!isGitHub(remote)) return { ...bail('not-github'), branch, remote }

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

  // Both are `gh` invocations of a few seconds each. Run together, they cost
  // one wait instead of two — and the second is needed the moment the user
  // says yes, so paying for it now keeps that answer instant.
  const [existingPr, ghReady] = await Promise.all([
    findOpenPr(options.cwd, branch),
    isGhReady(options.cwd),
  ])

  return { skip: null, branch, base, existingPr, remote, ghReady }
}

/**
 * Start the checks without waiting for them.
 *
 * Called before the commits are executed, so the `gh` round trips overlap with
 * work that was going to happen anyway. Waiting until after the last commit
 * lands turns them into several seconds of an apparently finished, silent
 * terminal — the exact moment a tool feels slowest.
 */
export interface PendingOffer {
  result: Promise<OfferFacts>
  /** False while the checks are still running. */
  settled: () => boolean
}

export function startOffer(options: GatherOptions): PendingOffer {
  let settled = false

  const result = gatherOffer(options)
    .catch(
      (): OfferFacts => ({
        skip: 'unavailable',
        branch: null,
        base: null,
        existingPr: null,
        remote: null,
        ghReady: false,
      }),
    )
    .then((context) => {
      settled = true
      return context
    })

  return { result, settled: () => settled }
}

export interface SummaryPaint {
  dim: (s: string) => string
  bold: (s: string) => string
}

/**
 * Say exactly what is about to happen, before asking whether to do it.
 *
 * Pushing and opening a pull request are the two things in this tool that other
 * people see. "Open a pull request?" on its own does not say from which branch,
 * into which branch, or to whose repository — and the wrong answer to any of
 * those is public. Every value here is one the run has already resolved, so
 * printing them costs nothing and removes the guesswork.
 */
export function renderNextStepSummary(
  context: OfferContext,
  paint: SummaryPaint,
): string {
  const rows: Array<[string, string]> = []

  if (context.branch) rows.push(['Branch', context.branch])

  if (context.remote) {
    const { host, owner, repo } = context.remote
    rows.push(['Repository', `${owner}/${repo} on ${host}`])
  }

  if (context.upstream) {
    const { upstream, ahead } = context.upstream
    rows.push([
      'Pushing',
      upstream === null
        ? 'creates the remote branch — it has never been pushed'
        : `${plural(ahead, 'commit')} to ${upstream}`,
    ])
  }

  if (context.step.action === 'push') {
    rows.push(['Updates', `pull request #${context.step.pr.number}`])
    rows.push(['', context.step.pr.url])
  } else if (context.step.action === 'open-pr' && context.base) {
    rows.push(['Opens', `a pull request into ${context.base}`])
  }

  const width = Math.max(...rows.map(([label]) => label.length))
  return rows
    .map(([label, value]) =>
      paint.dim(`  ${label.padEnd(width)}  `) + (label ? value : paint.dim(value)),
    )
    .join('\n')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
