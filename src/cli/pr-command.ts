import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createGit } from '../core/git/exec.js'
import {
  resolveBaseBranch,
  summarizeBranch,
  remoteNames,
  stripRemotePrefix,
} from '../core/git/branch.js'
import { createPrDraft } from '../core/engine/pr.js'
import { resolveProvider } from '../core/providers/resolve.js'
import { ensurePushed, openWebPr, editDraft, assertWebSupported } from './pr-flow.js'
import { bold, dim, green, yellow } from './render.js'
import { createSpinner } from './spinner.js'
import { confirm } from './prompt.js'
import type { Config } from '../core/config/schema.js'

export interface PrFlags {
  target?: string | undefined
  base?: string | undefined
  out?: string | undefined
  draft?: boolean | undefined
  web?: boolean | undefined
  open?: boolean | undefined
  edit?: boolean | undefined
  yes?: boolean | undefined
}

export type PrMode =
  /** Print the draft and change nothing. */
  | 'draft'
  /** Push, then open a prefilled compare page in the browser. */
  | 'web'
  /** Push, then create the pull request with the GitHub CLI. */
  | 'gh'

/**
 * What `unbraid pr` should actually do.
 *
 * Opening the browser is the default because it is what people run the command
 * for. Printing a draft used to be the default, and it made the useful path a
 * flag you had to know about — the command appeared to work and left you with
 * text to copy.
 *
 * Two cases fall back to printing: an explicit --draft, and anything that
 * signals a script rather than a person. Launching a browser out of a CI job or
 * a shell pipeline is never what was wanted.
 */
export function decidePrMode(flags: PrFlags, interactive: boolean): PrMode {
  if (flags.open) return 'gh'
  if (flags.draft) return 'draft'
  if (flags.web) return 'web'
  // --out means the draft is wanted as text somewhere.
  if (flags.out) return 'draft'
  if (!interactive) return 'draft'
  return 'web'
}

export interface RunPrOptions {
  cwd: string
  config: Config
  flags: PrFlags
  /** Defaults to whether stdin is a terminal. */
  interactive?: boolean
}

/**
 * Draft a pull request and, depending on the flags, print / write / open it.
 *
 * Lives here rather than inline in the command so the post-commit offer can
 * reuse it. Two implementations of "open a pull request" would drift, and the
 * one reached by the shortcut would be the one that drifts.
 */
export async function runPr(options: RunPrOptions): Promise<void> {
  const { cwd, config, flags } = options
  const mode = decidePrMode(flags, options.interactive ?? process.stdin.isTTY === true)
  const spinner = createSpinner()

  try {
    const git = createGit(cwd)
    // -t is the documented flag; --base is kept working for anyone who
    // scripted against it before -t existed.
    const requested = flags.target ?? flags.base ?? config.pr.target ?? undefined
    const target = await resolveBaseBranch(git, requested)
    const summary = await summarizeBranch(git, target)

    // Comparisons run against the resolved ref (`origin/master`); GitHub is
    // told the branch name (`master`). Passing the tracking ref to the host
    // builds a compare URL for a branch that does not exist there.
    const baseBranch = stripRemotePrefix(summary.base, await remoteNames(git))

    console.error(
      dim(
        `${summary.branch} → ${summary.base} · ${summary.commits.length} commits · ${summary.filesChanged} files`,
      ),
    )

    const provider = await resolveProvider(config)
    spinner.start(dim('Drafting pull request'))
    let draft = await createPrDraft(summary, config, provider)
    spinner.stop()

    if (flags.edit) {
      const edited = await editDraft(draft)
      if (!edited) {
        console.error(dim('Empty title — cancelled.'))
        return
      }
      draft = edited
    }

    if (flags.out) {
      await writeFile(flags.out, `${draft.title}\n\n${draft.body}\n`, 'utf8')
      console.error(green(`Wrote ${flags.out}`))
    }

    if (mode === 'draft') {
      console.log(bold(draft.title))
      console.log('')
      console.log(draft.body)
      return
    }

    if (mode === 'web') await assertWebSupported(git)

    const pushed = await ensurePushed({
      git,
      branch: summary.branch,
      remote: config.execute.pushRemote,
      confirm: async (reason, pushTarget) => {
        if (flags.yes) return true
        console.error(`\n${yellow(reason)}`)
        return confirm(`Push to ${pushTarget}?`, true)
      },
      onPushed: () => console.error(green('  ✓ pushed')),
    })
    if (!pushed) {
      console.error(dim('Not pushed, so no pull request was opened.'))
      return
    }

    if (mode === 'web') {
      await openWebPr({
        git,
        target: baseBranch,
        head: summary.branch,
        draft,
        onMessage: (message) => console.error(dim(message)),
      })
      return
    }

    console.log(bold(draft.title))
    console.log('')
    console.log(draft.body)
    console.error('')
    if (!flags.yes && !(await confirm(`Open this pull request against ${baseBranch}?`))) {
      console.error(dim('Not opened.'))
      return
    }
    await openPullRequest(cwd, baseBranch, draft.title, draft.body)
  } finally {
    spinner.stop()
  }
}

/**
 * Hand the draft to the GitHub CLI.
 *
 * The body goes in over stdin rather than as an argument: PR bodies routinely
 * exceed the operating system's argument length limit, and backticks in a
 * description would otherwise need escaping.
 */
export async function openPullRequest(
  cwd: string,
  base: string,
  title: string,
  body: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'gh',
      ['pr', 'create', '--base', base, '--title', title, '--body-file', '-'],
      { cwd, stdio: ['pipe', 'inherit', 'inherit'] },
    )

    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(
              'The GitHub CLI (`gh`) is not installed. Install it, or use --out and paste the body yourself.',
            )
          : error,
      )
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`gh pr create exited with ${code}`))
    })

    child.stdin?.end(body)
  })
}
