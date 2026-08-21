#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { Command } from 'commander'
import { loadConfig } from '../core/config/load.js'
import { createGit, type Git } from '../core/git/exec.js'
import { executePlan, push } from '../core/git/write.js'
import { readWorkingTree } from '../core/git/read.js'
import { buildPlan, PipelineError } from './pipeline.js'
import { checkSecrets, describeSecretWarning } from './guard.js'
import { renderPlan, describeFileCount, bold, cyan, dim, green, red, yellow } from './render.js'
import { createSpinner } from './spinner.js'
import { checkForUpdate } from './update-check.js'
import { BranchError, planPush, pushBranch } from '../core/git/branch.js'
import { runPr, type PrFlags } from './pr-command.js'
import {
  startOffer,
  completeOffer,
  renderNextStepSummary,
  type PendingOffer,
  type OfferContext,
} from './pr-offer.js'
import { confirm } from './prompt.js'
import type { CommitPlan, WorkingTreeState } from '../core/engine/types.js'
import type { Provider } from '../core/providers/types.js'
import { providerNameSchema, type Config } from '../core/config/schema.js'

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
  // -v, not commander's default -V. Every other tool people run all day
  // spells it lowercase, and a version flag is the one thing you type when you
  // are already unsure what you have installed.
  .version(__UNBRAID_VERSION__, '-v, --version', 'print the version and exit')
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
  $ unbraid pr                  open a pull request for this branch
  $ unbraid pr --draft          print the draft without opening anything
  $ unbraid pr -t dev           target a different branch
  $ unbraid config              show settings and where each came from
  $ unbraid -v                  print the installed version

After committing on a branch, unbraid offers to open a pull request for it.
Turn that off with pr.offerAfterCommit: false in your config.

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
    // Listed from the schema rather than written out, so adding a provider
    // cannot leave `--help` advertising the old set.
    .option('-p, --provider <name>', providerNameSchema.options.join(' | '))
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
      // Ink leaves stdin unref'd when it unmounts, so it no longer holds the
      // event loop open. Anything that prompts afterwards — the pull request
      // offer — reads a stream nothing is waiting on: the question prints, the
      // keystroke never arrives, and node exits with "unsettled top-level
      // await". Handing stdin back here rather than at each prompt keeps every
      // future caller from having to know this.
      if (process.stdin.isTTY) process.stdin.ref()
      resolve(settled ?? { outcome: 'cancel', plan })
    })
  })
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

/**
 * End the run.
 *
 * A command that has printed its last line should give the shell back. Two
 * things keep this one alive past that point, and both are deliberate
 * elsewhere: stdin stays referenced so the questions after the review screen
 * can be answered, and the update check leaves a request in flight because its
 * answer is only ever used by the *next* run. Neither is worth waiting on, and
 * the second cannot reliably be cancelled — an in-progress DNS lookup ignores
 * the abort signal and can hold the process for a minute or more.
 *
 * So the run ends when the work is done. Output is drained first: process.exit
 * discards writes still queued, which matters the moment stdout is a pipe.
 */
async function finish(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stdin.pause()
    process.stdin.unref()
  }

  await Promise.all([drain(process.stdout), drain(process.stderr)])
  process.exit(process.exitCode ?? 0)
}

function drain(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve())
  })
}

/**
 * Once the commits exist, offer to turn them into a pull request.
 *
 * The commits are the work; the pull request is what makes them visible to
 * anybody else. Asking here saves re-deriving the base branch and running a
 * second command, and it asks at the one moment the answer is obvious.
 *
 * Nothing in here may fail the run. The commits are already made and safe —
 * reporting a non-zero exit over a declined pull request would say otherwise.
 */
async function offerPullRequest(options: {
  cwd: string
  git: Git
  config: Config
  pending: PendingOffer
  provider: Provider
  unattended: boolean
}): Promise<void> {
  const spinner = createSpinner()

  try {
    // Normally already finished, having run alongside the commits. The spinner
    // is for the slow network that is the whole reason this starts early.
    if (!options.pending.settled()) spinner.start(dim('Checking GitHub'))
    const facts = await options.pending.result
    spinner.stop()

    // Measured now, not alongside the commits: this is the one number the
    // commits change. Reading it early is what made unbraid announce that a
    // pull request already held commits made a moment later.
    const push =
      facts.skip === null && facts.branch !== null
        ? await planPush(options.git, options.config.execute.pushRemote, facts.branch)
        : null

    const context = completeOffer(facts, push, {
      enabled: options.config.pr.offerAfterCommit,
      interactive: process.stdin.isTTY === true,
      unattended: options.unattended,
    })

    if (context.step.action === 'none') {
      // Worth saying out loud rather than staying silent: the work is on a
      // pull request that already has it. Nothing to do, but knowing that
      // beats wondering why nothing was offered.
      if (context.step.reason === 'already-open' && context.existingPr) {
        console.log(
          dim(`\nPull request #${context.existingPr.number} already has these commits.`),
        )
        console.log(dim(`  ${context.existingPr.url}`))
      }
      return
    }

    // Say what is about to happen before asking whether to do it. Both actions
    // are visible to other people, and neither question names the branches on
    // its own.
    console.log('')
    console.log(renderNextStepSummary(context, { dim, bold }))
    console.log('')

    if (context.step.action === 'push') {
      await offerPush(context, options.config, options.cwd)
      return
    }

    if (!(await confirm('Open this pull request?', true))) {
      console.log(dim('Not now. Run `unbraid pr` whenever you are ready.'))
      return
    }

    // `gh` creates the pull request outright. Without it, a prefilled compare
    // page needs nothing but the browser session the user already has. Which
    // one was worked out during the commits, so this costs nothing here.
    const flags = context.ghReady ? { open: true } : { web: true }
    console.log('')
    // The provider is passed along rather than resolved again: it was already
    // chosen to write the commit messages, and re-resolving spawns a probe.
    await runPr({
      cwd: options.cwd,
      config: options.config,
      flags,
      provider: options.provider,
    })
  } catch (error) {
    spinner.stop()
    console.error(
      yellow(
        `\nCould not finish: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    console.error(dim('Your commits are safe. Run `unbraid pr` to try again.'))
  }
}

/**
 * The branch has an open pull request, so pushing is what puts the new commits
 * on it. No model call and no draft — just the one thing left to do.
 */
async function offerPush(
  context: OfferContext,
  config: Config,
  cwd: string,
): Promise<void> {
  if (context.step.action !== 'push' || context.branch === null) return

  // The ref the push writes to, never the tracking ref: they are not always
  // the same branch, and this question is the last thing before it happens.
  const target = context.push?.ref ?? `${config.execute.pushRemote}/${context.branch}`

  if (!(await confirm(`Push to ${target}?`, true))) {
    console.log(dim('Not now. Push whenever you are ready.'))
    return
  }

  const spinner = createSpinner()
  spinner.start(dim(`Pushing to ${target}`))
  try {
    await pushBranch(
      createGit(cwd),
      config.execute.pushRemote,
      context.branch,
      // Set upstream only when this branch is not on the remote yet. Keyed on
      // the branch's own ref, so a branch tracking something else still gets
      // its tracking corrected on the first push.
      context.push?.exists === false,
    )
  } finally {
    spinner.stop()
  }

  console.log(green(`✓ Pushed to ${target}`))
  console.log(dim(`  Pull request #${context.step.pr.number} is up to date.`))
  console.log(dim(`  ${context.step.pr.url}`))
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
      // Every one of these is git work that takes long enough to notice on a
      // big repository. Before, the first thing on screen was the summary line
      // below — printed only once all of it had finished.
      onStage: (stage) => {
        spinner.start(
          dim(
            {
              reading: 'Reading your working tree',
              style: 'Reading how this repository writes commits',
              diffing: 'Reading what changed',
              hunks: 'Splitting files into hunks',
            }[stage],
          ),
        )
      },
      onTreeRead: (state, provider, style) => {
        spinner.stop()
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

        // Started here, not after the commits: these are `gh` round trips of a
        // few seconds, and after the last commit lands they would be silence in
        // a terminal that looks finished.
        const pendingOffer = startOffer({
          git,
          cwd,
          enabled: config.pr.offerAfterCommit,
          interactive: process.stdin.isTTY === true,
          unattended: skipReview,
          target: config.pr.target ?? undefined,
        })

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
          const pushSpinner = createSpinner()
          pushSpinner.start(dim(`Pushing to ${config.execute.pushRemote}`))
          try {
            await push(git, { remote: config.execute.pushRemote })
          } finally {
            pushSpinner.stop()
          }
          console.log(green('Pushed.'))
        }

        await offerPullRequest({
          cwd,
          git,
          config,
          pending: pendingOffer,
          provider,
          unattended: skipReview,
        })
        await noticeUpdate(config, isOnMachine(provider))
      } catch (error) {
        fail(error)
      } finally {
        await finish()
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
    .description(
      "Open a pull request for this branch, with the title and body written for you.",
    )
    .option('-t, --target <branch>', 'branch to merge into (auto-detected)')
    .option('-b, --base <branch>', 'alias for --target')
    .option('-o, --out <file>', 'write the draft to a file')
    .option('--draft', 'print the draft instead of opening anything')
    .option('--web', 'open a prefilled pull request page in your browser (default)')
    .option('--open', 'create the pull request with the GitHub CLI instead')
    .option('-e, --edit', 'revise the draft in $EDITOR first')
    .option('-y, --yes', 'skip the push confirmation')
    .action(async (flags: CommonFlags & PrFlags) => {
      try {
        const cwd = process.cwd()
        const loaded = await loadConfig({ cwd, flags: flagsToConfig(flags) as never })
        warnUnknownKeys(loaded.unknownKeys)

        await runPr({ cwd, config: loaded.config, flags })
      } catch (error) {
        if (error instanceof BranchError) {
          console.error(red(error.message))
          if (error.hint) console.error(dim(error.hint))
          process.exit(1)
        }
        fail(error)
      }
    }),
)

// ---------------------------------------------------------------------------

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
