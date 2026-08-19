import { createInterface } from 'node:readline/promises'
import { writeFile, mkdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PRESETS,
  buildConfig,
  hostOf,
  normalizeBaseUrl,
  renderConfigFile,
  serviceName,
  type InitAnswers,
  type Preset,
} from './init.js'
import { isClaudeCliAvailable } from '../core/providers/claude-cli.js'
import { isCodexCliAvailable } from '../core/providers/codex-cli.js'
import { resolveProvider } from '../core/providers/resolve.js'
import { configSchema } from '../core/config/schema.js'
import { bold, cyan, dim, green, red, yellow } from './render.js'
import { createSpinner } from './spinner.js'
import {
  reduceSelect,
  renderSelect,
  selectHeight,
  type Key,
  type SelectOption,
} from './prompt.js'
import {
  saveCredential,
  readCredentials,
  credentialsPath,
  maskKey,
} from '../core/config/credentials.js'

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

  /**
   * Ask a question, treating a closed input as a cancellation.
   *
   * readline rejects with "readline was closed" when stdin ends mid-prompt —
   * which is what Ctrl-D does. Surfacing that raw tells the user their setup
   * crashed when in fact they cancelled it.
   *
   * The interface is created and closed per question rather than held open for
   * the whole wizard. A long-lived interface has to share stdin with the raw
   * key handling in `choose` below, and the two fight over it: the list would
   * work once and every prompt after it would hang forever.
   */
  const ask = async (question: string, fallback = ''): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let answer: string
    try {
      answer = await rl.question(question)
    } catch {
      throw new SetupCancelled()
    } finally {
      rl.close()
    }
    const trimmed = answer.trim()
    return trimmed === '' ? fallback : trimmed
  }

  /**
   * A navigable list.
   *
   * Raw mode so arrow keys arrive as keypresses rather than as escape
   * sequences buried in a line of text. Typing a digit both selects and
   * confirms, because at a numbered list "2" means "I want the second one",
   * not "highlight the second one".
   *
   * Falls back to the readline prompt when raw mode is unavailable — piped
   * input, or a terminal that does not support it — so the wizard still works
   * rather than throwing.
   */
  const choose = async (
    question: string,
    options_: SelectOption[],
    defaultIndex = 0,
  ): Promise<number> => {
    console.log(`\n${bold(question)}`)

    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      console.log(renderSelect(options_, defaultIndex, { cyan, dim, bold }))
      const raw = await ask(`\nChoice [${defaultIndex + 1}]: `, String(defaultIndex + 1))
      const index = Number(raw) - 1
      return Number.isInteger(index) && index >= 0 && index < options_.length
        ? index
        : defaultIndex
    }

    const height = selectHeight(options_)
    let index = defaultIndex

    const draw = (first: boolean) => {
      // Move back over the previous render and overwrite it, so the list
      // updates in place instead of scrolling a new copy on every keypress.
      if (!first) process.stdout.write(`\u001b[${height}A`)
      process.stdout.write(`\u001b[0J`)
      process.stdout.write(`${renderSelect(options_, index, { cyan, dim, bold })}\n`)
    }

    // Decode keypresses without building a readline interface. An interface
    // here would take ownership of stdin and hand it back in a state the next
    // question cannot read from.
    const { emitKeypressEvents } = await import('node:readline')
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write('\u001b[?25l')

    draw(true)
    console.log(dim('  ↑↓ move · 1-9 pick · enter confirm'))

    let onKey: ((str: string, key: Key) => void) | undefined

    try {
      return await new Promise<number>((resolve, reject) => {
        onKey = (_str, key) => {
          const action = reduceSelect(key, index, options_.length)

          if (action.type === 'move') {
            index = action.index
            // Redraw over the list and its hint line.
            process.stdout.write('\u001b[1A')
            draw(false)
            console.log(dim('  ↑↓ move · 1-9 pick · enter confirm'))
            return
          }
          if (action.type === 'choose') resolve(action.index)
          if (action.type === 'cancel') reject(new SetupCancelled())
        }
        process.stdin.on('keypress', onKey)
      })
    } finally {
      // Detached here rather than beside each resolve so cancellation is
      // covered too. A listener left behind eats the next question's input.
      if (onKey) process.stdin.off('keypress', onKey)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\u001b[?25h')
    }
  }

  /**
   * Ask for an API key and store it.
   *
   * Saved under the user's config directory, never in the repository config —
   * that file is meant to be committed, and a key written there gets pushed
   * sooner or later.
   *
   * Input is not masked. Terminal masking requires raw mode, which breaks
   * paste on several terminals, and a key nobody can paste is worse than one
   * briefly visible in a scrollback the user already controls.
   */
  /**
   * Ask for the key, naming the service it belongs to.
   *
   * The question used to be built from the environment variable — "Paste your
   * GROQ_API_KEY". That reads well only while the variable happens to be named
   * after the service. For an endpoint somebody typed in there is no such name,
   * and the prompt asked for an "UNBRAID_API_KEY", which sounds like an account
   * with us. There is no such thing. The key belongs to whatever is at the far
   * end of that URL, so that is what the question says; where it gets stored is
   * a detail, printed after.
   */
  const promptForKey = async (
    envVar: string,
    keyUrl: string | null,
    service: string,
  ): Promise<void> => {
    console.log('')
    if (keyUrl) console.log(`Get a key at ${cyan(keyUrl)}`)

    const key = await ask(`${bold(`Paste your ${service} API key`)} ${dim('(enter to skip): ')}`)
    if (key === '') {
      console.log(
        dim(`\nSkipped. Set ${envVar} in your shell, or run \`unbraid init\` again.`),
      )
      return
    }

    await saveCredential(envVar, key)
    console.log(green(`✓ Saved ${maskKey(key)} to ${credentialsPath()}`))
    console.log(
      dim(`  Stored outside your repository, readable only by you, as ${envVar}.`),
    )
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
    const codexAvailable = await isCodexCliAvailable()
    if (codexAvailable) {
      console.log(green('✓ Codex CLI found — free with your existing subscription'))
    }

    const providerChoices = [
      {
        label: claudeAvailable
          ? 'Claude Code — free, no API key, already installed'
          : 'Claude Code — free, but not installed yet',
        hint: claudeAvailable ? undefined : 'Install from https://claude.com/claude-code',
      },
      {
        label: codexAvailable
          ? 'Codex CLI — free, no API key, already installed'
          : 'Codex CLI — free, but not installed yet',
        hint: codexAvailable
          ? undefined
          : 'Install from https://developers.openai.com/codex/cli',
      },
      { label: 'Anthropic API', hint: 'Pay per use. Faster than the CLIs.' },
      {
        label: 'Something else (OpenAI, OpenRouter, Z.AI, Groq, DeepSeek, Ollama)',
        hint: 'Ollama runs on your own machine, for free.',
      },
    ]

    // Default to whichever free CLI is already installed, since that is the
    // option with nothing left to configure.
    const providerIndex = await choose(
      'Which AI should write your commit messages?',
      providerChoices,
      claudeAvailable ? 0 : codexAvailable ? 1 : 2,
    )

    const answers: InitAnswers = {
      provider: (['claude-cli', 'codex-cli', 'anthropic', 'openai-compatible'] as const)[
        providerIndex
      ]!,
    }

    // 2. Provider details, and whatever key it needs.
    let requiredEnv: string | null = null
    let keyUrl: string | null = null
    let presetNote: string | undefined
    /** What the key belongs to, in the words the user would use for it. */
    let keyService = 'provider'

    if (answers.provider === 'codex-cli') {
      answers.codexModel = await ask(
        `\n${bold('Model')} ${dim("[leave empty to let codex choose]")}: `,
        'auto',
      )
    } else if (answers.provider === 'anthropic') {
      requiredEnv = 'ANTHROPIC_API_KEY'
      keyUrl = 'https://console.anthropic.com/settings/keys'
      keyService = 'Anthropic'
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
      keyUrl = preset.keyUrl
      presetNote = preset.note

      if (preset.custom) {
        // Three questions, because none of them can be guessed for a gateway
        // somebody runs themselves.
        const api = preset.api ?? 'openai'
        const example =
          api === 'anthropic' ? 'https://your-gateway.example.com' : 'https://your-gateway.example.com/v1'

        let baseUrl = ''
        while (baseUrl === '') {
          const entered = await ask(`\n${bold('Endpoint')} ${dim(`e.g. ${example}`)}: `)
          baseUrl = normalizeBaseUrl(entered, api)
          if (baseUrl === '') console.log(red('An endpoint is required.'))
        }

        let model = ''
        while (model === '') {
          model = (await ask(`${bold('Model')} ${dim('as the endpoint names it')}: `)).trim()
          if (model === '') console.log(red('A model is required.'))
        }

        answers.preset = { ...preset, baseUrl, model }
        // Always ask: there is no shared account here whose key might already
        // be exported under a name unbraid would find.
        requiredEnv = preset.apiKeyEnv
        // The host, because that is the only name this endpoint has.
        keyService = hostOf(baseUrl)
      } else {
        requiredEnv = preset.keyUrl ? preset.apiKeyEnv : null
        keyService = serviceName(preset.label)
        const model = await ask(`\n${bold('Model')} ${dim(`[${preset.model}]`)}: `, preset.model)
        answers.preset = { ...preset, model }
      }
    }

    // 3. Commit size
    const granularityIndex = await choose('How big should each commit be?', [
      { label: 'One commit per feature or fix', hint: 'Recommended for most people' },
      { label: 'One commit per file', hint: 'Most detailed history' },
      { label: 'Few, large commits', hint: 'Grouped by features / fixes / chores' },
    ])
    answers.granularity = (['semantic', 'fine', 'coarse'] as const)[granularityIndex]

    // 4. The key, if one is needed.
    if (requiredEnv) {
      const stored = await readCredentials()
      const existing = process.env[requiredEnv] ?? stored[requiredEnv]

      if (existing) {
        console.log(green(`\n✓ ${requiredEnv} is already set (${maskKey(existing)})`))
        const replace = await ask(`${dim('Replace it? [y/N] ')}`, 'n')
        if (replace.toLowerCase() === 'y') {
          await promptForKey(requiredEnv, keyUrl, keyService)
        }
      } else {
        await promptForKey(requiredEnv, keyUrl, keyService)
      }
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
    // It is also a real model call: with a CLI provider that is a process
    // starting up, so it needs to look alive rather than finished.
    console.log('')
    const spinner = createSpinner()
    spinner.start(dim('Testing the connection'))
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
      spinner.stop()
      console.log(green(`✓ ${provider.name}/${provider.model} is working`))
      console.log(`\n${bold('Ready.')} Try it out:\n`)
      console.log('  cd your-project')
      console.log('  unbraid --dry-run\n')
    } catch (error) {
      spinner.stop()
      console.log(red(`✗ Could not reach the provider`))
      console.log(dim(`  ${error instanceof Error ? error.message : String(error)}`))
      console.log(
        `\nThe config file is saved. Fix the problem above, then run ${bold('unbraid --dry-run')} to retry.`,
      )
      // Only when there is genuinely no key to be found. A key pasted a moment
      // ago is saved and will be read back, so blaming an unset environment
      // variable sends the user to fix something that is not broken.
      if (requiredEnv) {
        const stored = await readCredentials()
        const haveKey = Boolean(process.env[requiredEnv] ?? stored[requiredEnv])
        if (!haveKey) {
          console.log(dim(`Most likely: no ${requiredEnv} is set yet.`))
        }
      }
    }
  } catch (error) {
    if (error instanceof SetupCancelled) {
      console.log(dim('\n\nSetup cancelled. Nothing was written.'))
      return
    }
    throw error
  } finally {
    // Every prompt closes its own reader, so the only thing left to undo is
    // raw mode — which stays on if the wizard threw mid-list.
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stdout.write('[?25h')
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
