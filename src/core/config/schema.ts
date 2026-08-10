import { z } from 'zod'

/**
 * unbraid's configuration.
 *
 * Every field has a default, and the defaults are chosen so that running
 * `unbraid` with no configuration at all is the intended experience. A config
 * file exists to adjust that behaviour, never to enable it.
 */

export const providerNameSchema = z.enum([
  'auto',
  'claude-cli',
  'anthropic',
  'openai-compatible',
])
export type ProviderName = z.infer<typeof providerNameSchema>

export const granularitySchema = z.enum(['fine', 'semantic', 'coarse'])
export type Granularity = z.infer<typeof granularitySchema>

export const messageFormatSchema = z.enum([
  'auto',
  'conventional',
  'gitmoji',
  'plain',
])
export type MessageFormat = z.infer<typeof messageFormatSchema>

const groupingHintSchema = z.object({
  /** Regular expression tested against each changed path. */
  match: z.string(),
  /** Commit title (or title prefix) that matching files are routed to. */
  group: z.string(),
})

export const configSchema = z.object({
  provider: providerNameSchema.default('auto'),
  model: z.string().default('auto'),

  providers: z
    .object({
      'claude-cli': z
        .object({
          bin: z.string().default('claude'),
          extraArgs: z.array(z.string()).default([]),
        })
        .default({}),
      anthropic: z
        .object({
          apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
          model: z.string().default('claude-sonnet-5'),
        })
        .default({}),
      'openai-compatible': z
        .object({
          baseUrl: z.string().default('https://api.openai.com/v1'),
          apiKeyEnv: z.string().default('OPENAI_API_KEY'),
          model: z.string().default('gpt-4o'),
        })
        .default({}),
    })
    .default({}),

  grouping: z
    .object({
      granularity: granularitySchema.default('semantic'),
      /** Hard ceiling. Exceeding it surfaces the plan for review, never a silent merge. */
      maxCommits: z.number().int().positive().default(20),
      /** Pre-staged files become a locked group the model never sees. */
      respectStaged: z.boolean().default(true),
      hints: z.array(groupingHintSchema).default([]),
      /** Untracked dirs larger than this stay a single entry. See git/read.ts. */
      expandUntrackedDirsUpTo: z.number().int().nonnegative().default(10),
    })
    .default({}),

  message: z
    .object({
      format: messageFormatSchema.default('auto'),
      types: z
        .array(z.string())
        .default([
          'feat',
          'fix',
          'refactor',
          'chore',
          'docs',
          'test',
          'style',
          'perf',
          'build',
          'ci',
        ]),
      scope: z.enum(['auto', 'off', 'required']).default('auto'),
      maxTitleLength: z.number().int().positive().default(72),
      body: z.enum(['always', 'never', 'auto']).default('auto'),
      bodyStyle: z.enum(['bullets', 'prose']).default('bullets'),
      language: z.string().default('en'),
      /** e.g. "([A-Z]+-\\d+)" to lift a ticket key out of the branch name. */
      ticketPattern: z.string().nullable().default(null),
      signOff: z.boolean().default(false),
    })
    .default({}),

  context: z
    .object({
      /** At or below this file count, skip pass 1 and send the full diff at once. */
      singlePassThreshold: z.number().int().nonnegative().default(15),
      truncateLines: z.number().int().nonnegative().default(20),
      maxDiffBytes: z.number().int().nonnegative().default(100_000),
      logSample: z.number().int().nonnegative().default(20),
      /** Withheld from the model. Still committed — see git/diff.ts. */
      exclude: z
        .array(z.string())
        .default([
          '*.lock',
          '*-lock.json',
          '*.min.js',
          '*.snap',
          'dist/**',
          '*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,eot}',
        ]),
    })
    .default({}),

  execute: z
    .object({
      push: z.boolean().default(false),
      pushRemote: z.string().default('origin'),
      /** Skip the review screen. For CI and scripts. */
      autoconfirm: z.boolean().default(false),
      onError: z.enum(['rollback', 'keep']).default('rollback'),
      /** Run the repository's git hooks. They are the user's rules. */
      verify: z.boolean().default(true),
    })
    .default({}),

  guard: z
    .object({
      /**
       * Halt before sending credential-shaped files to a REMOTE provider.
       * Skipped for claude-cli and localhost, where nothing leaves the machine.
       */
      secrets: z.boolean().default(true),
      secretPatterns: z
        .array(z.string())
        .default(['.env', '.env.*', '*.pem', '*_rsa', '*.key', '*.p12']),
    })
    .default({}),
})

export type Config = z.infer<typeof configSchema>

/** The fully-defaulted config, as produced by an empty input. */
export function defaultConfig(): Config {
  return configSchema.parse({})
}
