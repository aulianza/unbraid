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
  return buildPlan({
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
      if (event.type === 'grouping-start') {
        console.error(dim(`Grouping ${event.files} files…`))
      }
      if (event.type === 'grouping-done') {
        console.error(dim(`Writing ${event.groups} commit messages…`))
      }
      if (event.type === 'degraded') {
        console.error(yellow(`Grouping failed (${event.reason}); falling back to one commit.`))
      }
    },
  })
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
        const { config } = await loadConfig({ cwd, flags: flagsToConfig(flags) as never })
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

program
  .command('config')
  .description('Print the resolved configuration and where each value came from.')
  .action(async () => {
    try {
      const { config, provenance, filesRead } = await loadConfig({ cwd: process.cwd() })

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
