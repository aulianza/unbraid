import { createInterface } from 'node:readline/promises'
import { writeFile, mkdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PRESETS,
  buildConfig,
  exportLine,
  profilePath,
  renderConfigFile,
  type InitAnswers,
  type Preset,
} from './init.js'
import { isClaudeCliAvailable } from '../core/providers/claude-cli.js'
import { resolveProvider } from '../core/providers/resolve.js'
import { configSchema } from '../core/config/schema.js'
import { bold, cyan, dim, green, red, yellow } from './render.js'

export interface InitOptions {
  /** Write to ~/.config/unbraid rather than this project. */
  global?: boolean
  cwd: string
}

/** The user pressed Ctrl-D, or input ended. Not an error worth a stack trace. */
class SetupCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

/**
 * Interactive setup.
 *
 * The point of failure this exists for is "No AI provider available": someone
 * installs unbraid, runs it, hits an error about API keys, and stops. This walks
 * them from nothing to a working setup and, crucially, makes a real call at the
 * end. A wizard that writes a config file and wishes you luck has not finished
 * the job.
 */
export async function runInit(options: InitOptions): Promise<void> {
  // Without a terminal the first prompt reads EOF and readline dies with
  // "readline was closed", which tells the user nothing about what to do.
  if (!process.stdin.isTTY) {
    throw new Error(
      [
        '`unbraid init` needs an interactive terminal.',
        '',
        'To configure without prompts, write the file yourself:',
        '',
        '  # .unbraidrc.yaml',
        '  provider: anthropic',
        '',
        'Full reference: https://github.com/aulianza/unbraid#configuration',
      ].join('\n'),
    )
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  /**
   * Ask a question, treating a closed input as a cancellation.
   *
   * readline rejects with "readline was closed" when stdin ends mid-prompt —
   * which is what Ctrl-D does. Surfacing that raw tells the user their setup
   * crashed when in fact they cancelled it.
   */
  const ask = async (question: string, fallback = ''): Promise<string> => {
    let answer: string
    try {
      answer = await rl.question(question)
    } catch {
      throw new SetupCancelled()
    }
    const trimmed = answer.trim()
    return trimmed === '' ? fallback : trimmed
  }

  const choose = async (
    question: string,
    options_: Array<{ label: string; hint?: string }>,
    defaultIndex = 0,
  ): Promise<number> => {
    console.log(`\n${bold(question)}`)
    options_.forEach((option, i) => {
      const marker = i === defaultIndex ? cyan('❯') : ' '
      console.log(`  ${marker} ${i + 1}. ${option.label}`)
      if (option.hint) console.log(`       ${dim(option.hint)}`)
    })
    const raw = await ask(`\nChoice [${defaultIndex + 1}]: `, String(defaultIndex + 1))
    const index = Number(raw) - 1
    return Number.isInteger(index) && index >= 0 && index < options_.length
      ? index
      : defaultIndex
  }

  try {
    console.log(bold('\nunbraid setup\n'))

    const claudeAvailable = await isClaudeCliAvailable()
    console.log(
      claudeAvailable
        ? green('✓ Claude Code found — you can use it free with your existing subscription')
        : dim('· Claude Code not found on this machine'),
    )

    // 1. Provider
    const providerChoices = [
      {
        label: claudeAvailable
          ? 'Claude Code — free, no API key, already installed'
          : 'Claude Code — free, but not installed yet',
        hint: claudeAvailable ? undefined : 'Install from https://claude.com/claude-code',
      },
      { label: 'Anthropic API', hint: 'Pay per use. Faster than Claude Code.' },
      {
        label: 'Something else (OpenAI, OpenRouter, Groq, DeepSeek, Ollama)',
        hint: 'Ollama runs on your own machine for free.',
      },
    ]
    const providerIndex = await choose(
      'Which AI should write your commit messages?',
      providerChoices,
      claudeAvailable ? 0 : 1,
    )

    const answers: InitAnswers = {
      provider:
        providerIndex === 0
          ? 'claude-cli'
          : providerIndex === 1
            ? 'anthropic'
            : 'openai-compatible',
    }

    // 2. Provider details, and whatever key it needs.
    let requiredEnv: string | null = null
    let keyUrl: string | null = null
    let presetNote: string | undefined

    if (answers.provider === 'anthropic') {
      requiredEnv = 'ANTHROPIC_API_KEY'
      keyUrl = 'https://console.anthropic.com/settings/keys'
      answers.anthropicModel = await ask(
        `\n${bold('Model')} ${dim('[claude-sonnet-5]')}: `,
        'claude-sonnet-5',
      )
    } else if (answers.provider === 'openai-compatible') {
      const presetIndex = await choose(
        'Which service?',
        PRESETS.map((preset) => ({ label: preset.label, hint: preset.note })),
        0,
      )
      const preset: Preset = PRESETS[presetIndex]!
      answers.preset = preset
      requiredEnv = preset.keyUrl ? preset.apiKeyEnv : null
      keyUrl = preset.keyUrl
      presetNote = preset.note

      const model = await ask(`\n${bold('Model')} ${dim(`[${preset.model}]`)}: `, preset.model)
      answers.preset = { ...preset, model }
    }

    // 3. Commit size
    const granularityIndex = await choose('How big should each commit be?', [
      { label: 'One commit per feature or fix', hint: 'Recommended for most people' },
      { label: 'One commit per file', hint: 'Most detailed history' },
      { label: 'Few, large commits', hint: 'Grouped by features / fixes / chores' },
    ])
    answers.granularity = (['semantic', 'fine', 'coarse'] as const)[granularityIndex]

    // 4. The key, if one is needed and not already set.
    if (requiredEnv && !process.env[requiredEnv]) {
      console.log(`\n${yellow(`${requiredEnv} is not set.`)}`)
      if (keyUrl) console.log(`Get a key at ${cyan(keyUrl)}`)
      console.log('\nAdd this to your shell profile:')
      console.log(
        `  ${bold(exportLine(requiredEnv))}   ${dim(`# in ${profilePath(process.env.SHELL, homedir())}`)}`,
      )
      console.log(dim('\nThen open a new terminal, or run the export in this one.'))
    } else if (requiredEnv) {
      console.log(green(`\n✓ ${requiredEnv} is already set`))
    }
    if (presetNote) console.log(dim(`\n${presetNote}`))

    // 5. Write the file.
    const target = options.global
      ? join(homedir(), '.config', 'unbraid', 'config.yaml')
      : join(options.cwd, '.unbraidrc.yaml')

    if (await exists(target)) {
      const overwrite = await ask(
        `\n${yellow(`${target} already exists. Overwrite? [y/N] `)}`,
        'n',
      )
      if (overwrite.toLowerCase() !== 'y') {
        console.log(dim('\nKept your existing config. Here is what it would have been:\n'))
        console.log(renderConfigFile(answers))
        return
      }
    }

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, renderConfigFile(answers), 'utf8')
    console.log(green(`\n✓ Wrote ${target}`))

    // 6. Prove it works. This is the part that makes the wizard worth running.
    console.log(dim('\nTesting the connection…'))
    try {
      const config = configSchema.parse(buildConfig(answers))
      const provider = await resolveProvider(config)
      await provider.complete({
        system: 'You reply with structured output only.',
        prompt: 'Reply with ok set to true.',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        schemaName: 'health_check',
      })
      console.log(green(`✓ ${provider.name}/${provider.model} is working`))
      console.log(`\n${bold('Ready.')} Try it out:\n`)
      console.log('  cd your-project')
      console.log('  unbraid --dry-run\n')
    } catch (error) {
      console.log(red(`✗ Could not reach the provider`))
      console.log(dim(`  ${error instanceof Error ? error.message : String(error)}`))
      console.log(
        `\nThe config file is saved. Fix the problem above, then run ${bold('unbraid --dry-run')} to retry.`,
      )
      if (requiredEnv && !process.env[requiredEnv]) {
        console.log(dim(`Most likely: ${requiredEnv} is not set in this terminal yet.`))
      }
    }
  } catch (error) {
    if (error instanceof SetupCancelled) {
      console.log(dim('\n\nSetup cancelled. Nothing was written.'))
      return
    }
    throw error
  } finally {
    rl.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
