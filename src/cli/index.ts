#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { Command } from 'commander'
import { loadConfig } from '../core/config/load.js'
import { createGit } from '../core/git/exec.js'
import { executePlan, push } from '../core/git/write.js'
import { readWorkingTree } from '../core/git/read.js'
import { buildPlan, PipelineError } from './pipeline.js'
import { checkSecrets, describeSecretWarning } from './guard.js'
import { renderPlan, describeFileCount, bold, cyan, dim, green, red, yellow } from './render.js'
import { createSpinner } from './spinner.js'
import { checkForUpdate } from './update-check.js'
import { resolveBaseBranch, summarizeBranch, BranchError } from '../core/git/branch.js'
import { createPrDraft } from '../core/engine/pr.js'
import { ensurePushed, openWebPr, editDraft, assertWebSupported } from './pr-flow.js'
import { resolveProvider } from '../core/providers/resolve.js'
import type { CommitPlan, WorkingTreeState } from '../core/engine/types.js'
import type { Config } from '../core/config/schema.js'

/** Replaced at build time by tsup; see tsup.config.ts. */
declare const __UNBRAID_VERSION__: string

const program = new Command()

// Options after a subcommand belong to that subcommand. Without this, the
// program's own `-y, --yes` swallows `unbraid pr --yes`, which then silently
// does nothing — the flag parses, just onto the wrong command.
program.enablePositionalOptions()

program
  .name('unbraid')
  .description('Unbraid a tangled working tree into atomic commits, with AI-written messages.')
  .version(__UNBRAID_VERSION__)
  // Flag lists say what exists; examples say what to type. Most people reading
  // `-h` want the second.
  .addHelpText(
    'after',
    `
Examples:
  $ unbraid init                set up a provider, step by step
  $ unbraid                     plan, review, and commit
  $ unbraid --dry-run           show the plan, change nothing
  $ unbraid -g fine             one commit per file
  $ unbraid --hunks             split files that mix two concerns
  $ unbraid --push              commit, then push once at the end
  $ unbraid pr                  draft a pull request from this branch
  $ unbraid pr --web            open a prefilled PR page in your browser
  $ unbraid pr -t dev           target a different branch
  $ unbraid config              show settings and where each came from

Providers:
  With Claude Code installed, unbraid uses your existing subscription — no
  API key and no per-token cost. Otherwise set ANTHROPIC_API_KEY, or point
  providers.openai-compatible.baseUrl at OpenAI, OpenRouter, or Ollama.

Docs: https://github.com/aulianza/unbraid`,
  )

interface CommonFlags {
  granularity?: string
  hunks?: boolean
  provider?: string
  model?: string
  force?: boolean
  guard?: boolean
}

/** Translate CLI flags into a config-shaped override layer. */
function flagsToConfig(flags: CommonFlags & { push?: boolean }): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  if (flags.provider) overrides.provider = flags.provider
  if (flags.model) overrides.model = flags.model
  if (flags.granularity || flags.hunks) {
    overrides.grouping = {
      ...(flags.granularity ? { granularity: flags.granularity } : {}),
      ...(flags.hunks ? { hunks: true } : {}),
    }
  }
  if (flags.guard === false) overrides.guard = { secrets: false }
  if (flags.push) overrides.execute = { push: true }
  return overrides
}

/** Options every command that talks to a model needs. */
function addProviderOptions(command: Command): Command {
  return command
    .option('-p, --provider <name>', 'auto | claude-cli | anthropic | openai-compatible')
    .option('-m, --model <model>', 'model id or alias')
}

/**
 * Options that only mean something when planning commits.
 *
 * Kept separate from provider options so `unbraid pr` does not advertise
 * `--granularity` or `--no-guard`. Neither does anything there, and a flag that
 * silently does nothing is worse than an absent one.
 */
function addPlanningOptions(command: Command): Command {
  return addProviderOptions(command)
    .option('-g, --granularity <level>', 'fine | semantic | coarse')
    .option('--hunks', 'split a file across commits when it mixes concerns')
    .option('--force', 'proceed on a detached HEAD')
    .option('--no-guard', 'skip the credential check')
}

/**
 * Run the full-screen review editor and resolve with the user's decision.
 *
 * Imported lazily so that `plan --json`, `apply`, and `config` never pay to load
 * React and Ink — which is most of unbraid's startup cost.
 */
async function runReview(
  plan: CommitPlan,
  state: WorkingTreeState,
): Promise<{ outcome: 'commit' | 'cancel'; plan: CommitPlan }> {
  const [{ render }, React, { Review }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/App.js'),
  ])

  return new Promise((resolve) => {
    let settled: { outcome: 'commit' | 'cancel'; plan: CommitPlan } | null = null

    const instance = render(
      React.createElement(Review, {
        plan,
        state,
        onDone: (outcome, edited) => {
          settled = { outcome, plan: edited }
        },
      }),
    )

    void instance.waitUntilExit().then(() => {
      resolve(settled ?? { outcome: 'cancel', plan })
    })
  })
}

/**
 * Ask a yes/no question.
 *
 * `defaultYes` is for steps the user has already implicitly asked for — pushing
 * a branch when they ran `unbraid pr --open` is a prerequisite of the thing they
 * requested, not a separate decision. Prompts that stand on their own, such as
 * creating commits or sending credential-shaped files to a third party, keep
 * the default of No.
 */
async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]'
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase()
    if (answer === '') return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

/** A config key nobody reads is a setting the user thinks is working. */
function warnUnknownKeys(keys: string[]): void {
  if (keys.length === 0) return
  console.error(
    yellow(
      `Ignoring ${keys.length} unrecognised config key(s): ${keys.join(', ')}`,
    ),
  )
  console.error(dim('Config keys are camelCase, e.g. maxCommits, not max_commits.'))
}

/**
 * Print an update notice, if there is one to print.
 *
 * Called after the command's own output so it never delays or obscures it, and
 * skipped whenever a notice would be noise or unwelcome: no terminal, an
 * explicit opt-out, or a provider that runs on this machine.
 */
function isOnMachine(provider: { name: string; isRemote: boolean }): boolean {
  return provider.name === 'openai-compatible' && !provider.isRemote
}

async function noticeUpdate(config: Config, localProvider: boolean): Promise<void> {
  const disabled =
    !process.stderr.isTTY ||
    !config.updateCheck ||
    process.env.UNBRAID_NO_UPDATE_CHECK !== undefined ||
    process.env.CI !== undefined ||
    localProvider

  const message = await checkForUpdate({
    currentVersion: __UNBRAID_VERSION__,
    disabled,
  })
  if (message) console.error(`\n${dim(message)}`)
}

function fail(error: unknown): never {
  if (error instanceof PipelineError) {
    console.error(red(error.message))
    if (error.hint) console.error(dim(error.hint))
  } else {
    console.error(red(error instanceof Error ? error.message : String(error)))
  }
  process.exit(1)
}

/** Shared: build a plan, showing progress and running the credential guard. */
async function planWithProgress(cwd: string, config: Config, flags: CommonFlags) {
  const spinner = createSpinner()
  let expected = 0
  let written = 0
  let singlePass = false

  try {
    return await buildPlan({
      cwd,
      config,
      force: flags.force,
      onTreeRead: (state, provider, style) => {
        console.error(
          dim(
            `${state.files.length} changed · ${style.format} style · ${provider.name}/${provider.model}`,
          ),
        )
      },
      // The spinner owns the last line of output; leaving it running would
      // overwrite the prompt the user is being asked to answer.
      onPromptOpen: () => spinner.stop(),
      beforeModel: async (state, provider) => {
        if (!config.guard.secrets) return true
        const guard = checkSecrets(state.files, config.guard.secretPatterns, provider.isRemote)
        if (!guard.blocked) return true

        console.error('')
        console.error(yellow(describeSecretWarning(guard.matches, provider.name)))
        console.error('')
        return confirm('Send these to the provider anyway?')
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'grouping-start':
            // A single pass writes the messages in the same call, so promising
            // a separate "writing" stage afterwards would be a lie.
            spinner.start(
              dim(
                event.singlePass
                  ? `Reading ${event.files} files and writing messages`
                  : `Grouping ${event.files} files`,
              ),
            )
            singlePass = event.singlePass
            break
          case 'grouping-done':
            expected = event.groups
            if (!singlePass) {
              spinner.update(dim(`Writing commit messages  ${written}/${expected}`))
            }
            break
          case 'message-done':
            written++
            spinner.update(
              dim(`Writing commit messages  ${written}/${expected}`),
            )
            break
          case 'degraded':
            spinner.stop()
            console.error(
              yellow(`Grouping failed (${event.reason}); falling back to one commit.`),
            )
            break
        }
      },
    })
  } finally {
    spinner.stop()
  }
}

// ---------------------------------------------------------------------------

addPlanningOptions(
  program
    .option('-n, --dry-run', 'show the plan and exit without committing')
    .option('--push', 'push once after all commits land')
    .option('-y, --yes', 'skip confirmation')
    .action(async (flags: CommonFlags & { dryRun?: boolean; yes?: boolean; push?: boolean }) => {
      try {
        const cwd = process.cwd()
        const loaded = await loadConfig({ cwd, flags: flagsToConfig(flags) as never })
        warnUnknownKeys(loaded.unknownKeys)
        const { config } = loaded
        const { git, state, plan, hunkContext, provider } = await planWithProgress(
          cwd,
          config,
          flags,
        )

        if (flags.dryRun || !process.stdin.isTTY) {
          console.log('')
          console.log(renderPlan(plan, state))
        }

        if (flags.dryRun) {
          console.log(dim('Dry run — nothing was committed.'))
          await noticeUpdate(config, isOnMachine(provider))
          return
        }

        const skipReview = flags.yes || config.execute.autoconfirm
        let approved = plan

        if (skipReview) {
          // Nothing to confirm; fall through and commit the plan as generated.
        } else if (process.stdin.isTTY) {
          const review = await runReview(plan, state)
          if (review.outcome === 'cancel') {
            console.log(dim('Cancelled. Nothing was committed.'))
            return
          }
          approved = review.plan
        } else {
          // Piped or non-interactive: the full-screen editor cannot run, so fall
          // back to a plain prompt rather than committing without asking.
          const proceed = await confirm(
            `Create ${plan.commits.length} commits from ${describeFileCount(
              plan.commits.flatMap((c) => c.files),
              state,
            )}?`,
          )
          if (!proceed) {
            console.log(dim('Cancelled. Nothing was committed.'))
            return
          }
        }

        const result = await executePlan(git, approved, {
          verify: config.execute.verify,
          ...(hunkContext ? { hunkContext } : {}),
          onCommit: (_id, sha, index, count) =>
            console.log(green(`  ✓ ${index}/${count}  ${sha.slice(0, 8)}`)),
        })

        if (result.rolledBack) {
          console.error(red(`Failed: ${result.rolledBack.reason}`))
          console.error(dim('Every commit was undone and your staging was restored.'))
          process.exit(1)
        }

        console.log(green(`\n${result.shas.length} commits created.`))

        if (config.execute.push) {
          console.log(dim(`Pushing to ${config.execute.pushRemote}…`))
          await push(git, { remote: config.execute.pushRemote })
          console.log(green('Pushed.'))
        }

        await noticeUpdate(config, isOnMachine(provider))
      } catch (error) {
        fail(error)
      }
    }),
)

// ---------------------------------------------------------------------------

addPlanningOptions(
  program
    .command('plan')
    .description('Emit a CommitPlan as JSON. Makes no changes.')
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .action(async (flags: CommonFlags & { out?: string }) => {
      try {
        const cwd = process.cwd()
        const { config } = await loadConfig({ cwd, flags: flagsToConfig(flags) as never })
        const { plan } = await planWithProgress(cwd, config, flags)
        const json = JSON.stringify(plan, null, 2)

        if (flags.out) {
          await writeFile(flags.out, json, 'utf8')
          console.error(green(`Wrote ${flags.out}`))
        } else {
          console.log(json)
        }
      } catch (error) {
        fail(error)
      }
    }),
)

// ---------------------------------------------------------------------------

program
  .command('apply')
  .description('Execute a plan produced by `unbraid plan`.')
  .requiredOption('--plan <file>', 'path to a plan JSON file')
  .option('--push', 'push once after all commits land')
  .option('-y, --yes', 'skip confirmation')
  .action(async (flags: { plan: string; push?: boolean; yes?: boolean }) => {
    try {
      const cwd = process.cwd()
      const { config } = await loadConfig({ cwd })
      const git = createGit(cwd)

      const raw = await readFile(flags.plan, 'utf8')
      const plan = JSON.parse(raw) as CommitPlan

      if (plan.version !== 1) {
        throw new PipelineError(
          `Unsupported plan version ${plan.version}.`,
          'This plan was written by a different version of unbraid.',
        )
      }

      const state = await readWorkingTree(git, {
        expandUntrackedDirsUpTo: config.grouping.expandUntrackedDirsUpTo,
      })

      console.log(renderPlan(plan, state))

      const proceed = flags.yes || (await confirm(`Create ${plan.commits.length} commits?`))
      if (!proceed) {
        console.log(dim('Cancelled.'))
        return
      }

      const result = await executePlan(git, plan, { verify: config.execute.verify })
      if (result.rolledBack) {
        console.error(red(`Failed: ${result.rolledBack.reason}`))
        process.exit(1)
      }

      console.log(green(`${result.shas.length} commits created.`))
      if (flags.push) {
        await push(git, { remote: config.execute.pushRemote })
        console.log(green('Pushed.'))
      }
    } catch (error) {
      fail(error)
    }
  })

// ---------------------------------------------------------------------------

addProviderOptions(
  program
    .command('pr')
    .description("Draft a pull request title and body from this branch's commits.")
    .option('-t, --target <branch>', 'branch to merge into (auto-detected)')
    .option('-b, --base <branch>', 'alias for --target')
    .option('-o, --out <file>', 'write the draft to a file')
    .option('--web', 'open a prefilled pull request page in your browser')
    .option('--open', 'create the pull request with the GitHub CLI')
    .option('-e, --edit', 'revise the draft in $EDITOR first')
    .option('-y, --yes', 'skip the push confirmation')
    .action(
      async (
        flags: CommonFlags & {
          target?: string
          base?: string
          out?: string
          web?: boolean
          open?: boolean
          edit?: boolean
          yes?: boolean
        },
      ) => {
        const spinner = createSpinner()
        try {
          const cwd = process.cwd()
          const loaded = await loadConfig({ cwd, flags: flagsToConfig(flags) as never })
          warnUnknownKeys(loaded.unknownKeys)

          const git = createGit(cwd)
          // -t is the documented flag; --base is kept working for anyone who
          // scripted against it before -t existed.
          const requested = flags.target ?? flags.base ?? loaded.config.pr.target ?? undefined
          const target = await resolveBaseBranch(git, requested)
          const summary = await summarizeBranch(git, target)

          console.error(
            dim(
              `${summary.branch} → ${summary.base} · ${summary.commits.length} commits · ${summary.filesChanged} files`,
            ),
          )

          const provider = await resolveProvider(loaded.config)
          spinner.start(dim('Drafting pull request'))
          let draft = await createPrDraft(summary, loaded.config, provider)
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

          // Printing is the default; --web and --open are additive.
          if (!flags.web && !flags.open) {
            console.log(bold(draft.title))
            console.log('')
            console.log(draft.body)
            return
          }

          if (flags.web) await assertWebSupported(git)

          const pushed = await ensurePushed({
            git,
            branch: summary.branch,
            remote: loaded.config.execute.pushRemote,
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

          if (flags.web) {
            await openWebPr({
              git,
              target: summary.base,
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
          if (!flags.yes && !(await confirm(`Open this pull request against ${summary.base}?`))) {
            console.error(dim('Not opened.'))
            return
          }
          await openPullRequest(cwd, summary.base, draft.title, draft.body)
        } catch (error) {
          spinner.stop()
          if (error instanceof BranchError) {
            console.error(red(error.message))
            if (error.hint) console.error(dim(error.hint))
            process.exit(1)
          }
          fail(error)
        }
      },
    ),
)

/**
 * Hand the draft to the GitHub CLI.
 *
 * The body goes in over stdin rather than as an argument: PR bodies routinely
 * exceed the operating system's argument length limit, and backticks in a
 * description would otherwise need escaping.
 */
async function openPullRequest(
  cwd: string,
  base: string,
  title: string,
  body: string,
): Promise<void> {
  const { spawn } = await import('node:child_process')

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

program
  .command('init')
  .description('Set up unbraid step by step, and test that it works.')
  .option('--global', 'write to ~/.config/unbraid instead of this project')
  .action(async (flags: { global?: boolean }) => {
    try {
      // Imported lazily so the wizard's prompts are not loaded on every run.
      const { runInit } = await import('./init-run.js')
      await runInit({ cwd: process.cwd(), global: flags.global })
    } catch (error) {
      fail(error)
    }
  })

program
  .command('config')
  .description('Print the resolved configuration and where each value came from.')
  .action(async () => {
    try {
      const { config, provenance, filesRead, unknownKeys } = await loadConfig({
        cwd: process.cwd(),
      })

      warnUnknownKeys(unknownKeys)

      console.log(bold('Config files read:'))
      console.log(
        filesRead.length > 0
          ? filesRead.map((f) => `  ${f}`).join('\n')
          : dim('  (none — all defaults)'),
      )
      console.log('')

      const flat = flatten(config)
      const width = Math.max(...flat.map(([key]) => key.length))
      for (const [key, value] of flat) {
        const source = provenance[key] ?? 'default'
        const rendered = source === 'default' ? dim(String(value)) : cyan(String(value))
        console.log(`  ${key.padEnd(width)}  ${rendered}  ${dim(`(${source})`)}`)
      }
    } catch (error) {
      fail(error)
    }
  })

function flatten(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [[prefix, Array.isArray(value) ? JSON.stringify(value) : value]]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  )
}

program.parseAsync(process.argv).catch(fail)
