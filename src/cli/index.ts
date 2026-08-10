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
import { resolveBaseBranch, summarizeBranch, BranchError } from '../core/git/branch.js'
import { createPrDraft } from '../core/engine/pr.js'
import { resolveProvider } from '../core/providers/resolve.js'
import type { CommitPlan, WorkingTreeState } from '../core/engine/types.js'
import type { Config } from '../core/config/schema.js'

/** Replaced at build time by tsup; see tsup.config.ts. */
declare const __UNBRAID_VERSION__: string

const program = new Command()

program
  .name('unbraid')
  .description('Unbraid a tangled working tree into atomic commits, with AI-written messages.')
  .version(__UNBRAID_VERSION__)

interface CommonFlags {
  granularity?: string
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
  if (flags.granularity) overrides.grouping = { granularity: flags.granularity }
  if (flags.guard === false) overrides.guard = { secrets: false }
  if (flags.push) overrides.execute = { push: true }
  return overrides
}

function addCommonOptions(command: Command): Command {
  return command
    .option('-g, --granularity <level>', 'fine | semantic | coarse')
    .option('-p, --provider <name>', 'auto | claude-cli | anthropic | openai-compatible')
    .option('-m, --model <model>', 'model id or alias')
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

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
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

addCommonOptions(
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
        const { git, state, plan } = await planWithProgress(cwd, config, flags)

        if (flags.dryRun || !process.stdin.isTTY) {
          console.log('')
          console.log(renderPlan(plan, state))
        }

        if (flags.dryRun) {
          console.log(dim('Dry run — nothing was committed.'))
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
      } catch (error) {
        fail(error)
      }
    }),
)

// ---------------------------------------------------------------------------

addCommonOptions(
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

addCommonOptions(
  program
    .command('pr')
    .description("Draft a pull request title and body from this branch's commits.")
    .option('-b, --base <branch>', 'branch to compare against (auto-detected)')
    .option('-o, --out <file>', 'write the draft to a file')
    .option('--open', 'create the pull request with the GitHub CLI')
    .action(async (flags: CommonFlags & { base?: string; out?: string; open?: boolean }) => {
      const spinner = createSpinner()
      try {
        const cwd = process.cwd()
        const loaded = await loadConfig({ cwd, flags: flagsToConfig(flags) as never })
        warnUnknownKeys(loaded.unknownKeys)

        const git = createGit(cwd)
        const base = await resolveBaseBranch(git, flags.base)
        const summary = await summarizeBranch(git, base)

        console.error(
          dim(
            `${summary.branch} → ${summary.base} · ${summary.commits.length} commits · ${summary.filesChanged} files`,
          ),
        )

        const provider = await resolveProvider(loaded.config)
        spinner.start(dim('Drafting pull request'))
        const draft = await createPrDraft(summary, loaded.config, provider)
        spinner.stop()

        if (flags.out) {
          await writeFile(flags.out, `${draft.title}\n\n${draft.body}\n`, 'utf8')
          console.error(green(`Wrote ${flags.out}`))
        }

        console.log(bold(draft.title))
        console.log('')
        console.log(draft.body)

        if (flags.open) {
          console.error('')
          const proceed = await confirm(`Open this pull request against ${base}?`)
          if (!proceed) {
            console.error(dim('Not opened.'))
            return
          }
          await openPullRequest(cwd, base, draft.title, draft.body)
        }
      } catch (error) {
        spinner.stop()
        if (error instanceof BranchError) {
          console.error(red(error.message))
          if (error.hint) console.error(dim(error.hint))
          process.exit(1)
        }
        fail(error)
      }
    }),
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
