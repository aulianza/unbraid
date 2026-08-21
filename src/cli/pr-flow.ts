import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Git } from '../core/git/exec.js'
import {
  planPush,
  pushBranch,
  BranchError,
  type PushPlan,
} from '../core/git/branch.js'
import { readRemote, isGitHub, type Remote } from '../core/git/remote.js'
import { planCompareUrl, describeDroppedBody } from '../core/engine/pr-url.js'
import { openUrl, copyToClipboard } from './open-url.js'
import type { PrDraft } from '../core/engine/pr.js'

export interface PushDecision {
  needed: boolean
  reason: string
  setUpstream: boolean
}

/**
 * Decide whether the branch must be pushed before a pull request can be opened.
 *
 * Separated from the prompting so the rule is testable: a branch the host does
 * not have cannot be opened as a pull request at all, and one that is behind
 * produces a pull request missing the newest commits — which looks like success
 * and is the more dangerous of the two.
 *
 * Judged on the branch's own ref on the remote, not on whatever it happens to
 * track. A branch created from `dev` keeps `origin/dev` as its upstream while
 * pushing to its own name, so reading the upstream answers a different question
 * than the one being asked here.
 */
export function decidePush(plan: PushPlan, branch: string): PushDecision {
  if (!plan.exists) {
    return {
      needed: true,
      reason: `${branch} is not on the remote yet. GitHub cannot open a pull request for a branch it cannot see.`,
      setUpstream: true,
    }
  }
  if (plan.ahead > 0) {
    return {
      needed: true,
      reason: `${branch} has ${plan.ahead} commit${plan.ahead === 1 ? '' : 's'} that ${plan.ref} does not. The pull request would be missing them.`,
      setUpstream: false,
    }
  }
  return { needed: false, reason: '', setUpstream: false }
}

export interface EnsurePushedOptions {
  git: Git
  branch: string
  remote: string
  /** Returns true to proceed with the push. */
  confirm: (reason: string, target: string) => Promise<boolean>
  /** Called once the push actually starts. It is a network round trip. */
  onPushStart?: (target: string) => void
  onPushed?: () => void
}

/** Returns false when the user declined and the flow should stop. */
export async function ensurePushed(
  options: EnsurePushedOptions,
): Promise<boolean> {
  const plan = await planPush(options.git, options.remote, options.branch)
  const decision = decidePush(plan, options.branch)
  if (!decision.needed) return true

  const target = plan.ref
  if (!(await options.confirm(decision.reason, target))) return false

  options.onPushStart?.(target)
  await pushBranch(options.git, options.remote, options.branch, decision.setUpstream)
  options.onPushed?.()
  return true
}

export interface OpenWebOptions {
  git: Git
  target: string
  head: string
  draft: PrDraft
  onMessage: (message: string) => void
}

/**
 * Open a prefilled GitHub compare page.
 *
 * The point of this path is that it needs no CLI, no token, and no
 * authentication beyond the browser session the user already has.
 */
export async function assertWebSupported(git: Git): Promise<Remote> {
  const remote = await readRemote(git)
  if (!remote) {
    throw new BranchError(
      'No `origin` remote found.',
      'Add one with: git remote add origin <url>',
    )
  }
  if (!isGitHub(remote)) {
    throw new BranchError(
      `--web only supports GitHub, and origin points at ${remote.host}.`,
      'Use `unbraid pr -o pr.md` and paste the contents instead.',
    )
  }
  return remote
}

export async function openWebPr(options: OpenWebOptions): Promise<void> {
  // Checked again here so the function is safe to call on its own, but the CLI
  // calls assertWebSupported first: being asked to push and only then told the
  // host is unsupported is a bad order to learn it in.
  const remote = await assertWebSupported(options.git)

  const plan = planCompareUrl({
    remote,
    target: options.target,
    head: options.head,
    title: options.draft.title,
    body: options.draft.body,
  })

  if (!plan.bodyIncluded) {
    const copied = await copyToClipboard(options.draft.body)
    options.onMessage(
      copied
        ? describeDroppedBody(plan.bodyBytes)
        : `Description is too long for a URL and could not be copied to the clipboard. Use --out to save it to a file.`,
    )
  }

  options.onMessage(`Opening ${remote.owner}/${remote.repo} in your browser…`)
  await openUrl(plan.url)
}

/**
 * Let the user revise the draft in $EDITOR.
 *
 * The first line is the title and the rest is the body, matching how git itself
 * treats a commit message — a convention the audience already knows.
 */
export async function editDraft(draft: PrDraft): Promise<PrDraft | null> {
  const dir = await mkdtemp(join(tmpdir(), 'unbraid-pr-'))
  const file = join(dir, 'PULL_REQUEST_EDITMSG.md')

  try {
    await writeFile(
      file,
      [
        draft.title,
        '',
        draft.body,
        '',
        '<!-- First line is the title, the rest is the description.',
        '     Save and close to continue. Empty the file to cancel. -->',
        '',
      ].join('\n'),
      'utf8',
    )

    await runEditor(file)

    const edited = await readFile(file, 'utf8')
    const lines = edited
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('<!--') && !line.includes('-->'))

    const title = (lines.shift() ?? '').trim()
    if (title === '') return null

    return { title, body: lines.join('\n').trim() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runEditor(file: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'nano'

  await new Promise<void>((resolve, reject) => {
    // `shell: true` because EDITOR is commonly set with arguments, such as
    // "code --wait" or "subl -w".
    const child = spawn(`${editor} "${file}"`, { stdio: 'inherit', shell: true })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${editor} exited with ${code}`)),
    )
  })
}
