import type { JsonSchema } from '../providers/types.js'
import type { Config } from '../config/schema.js'
import type { FileChange } from './types.js'
import type { FileDiff } from '../git/diff.js'
import type { RepoStyle } from './style.js'

/**
 * Schemas are hand-written rather than derived from zod.
 *
 * Every provider needs raw JSON Schema, and the three that matter disagree about
 * which keywords they accept. Writing them by hand keeps the wire format visible
 * and avoids a conversion layer whose output nobody reads.
 */

export const GROUPING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Commit subject line, in the repository style.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Paths, copied exactly as given.',
          },
          warnings: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Notes about files that mix unrelated concerns. Empty if none.',
          },
        },
        required: ['title', 'files', 'warnings'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
}

export const MESSAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Subject line only.' },
    body: {
      type: 'string',
      description: 'Explanation, or an empty string when the title says it all.',
    },
  },
  required: ['title', 'body'],
  additionalProperties: false,
}

export const SINGLE_PASS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'body', 'files', 'warnings'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
}

const GRANULARITY_GUIDANCE: Record<Config['grouping']['granularity'], string> = {
  fine: [
    'Prefer one commit per file.',
    'Group files together only when they are genuinely inseparable: a rename pair,',
    'a component and its own test, a type and its only consumer.',
  ].join(' '),
  semantic: [
    'Group by intent: one feature, fix, or refactor per commit.',
    'Files serving the same purpose belong together even across directories.',
  ].join(' '),
  coarse: [
    'Group broadly, by top-level concern only: features, fixes, chores.',
    'Aim for a small number of large commits.',
  ].join(' '),
}

/** Describe the repository's own conventions so output looks native to it. */
export function buildSystemPrompt(config: Config, style: RepoStyle): string {
  const format =
    config.message.format === 'auto' ? style.format : config.message.format

  const lines = [
    'You split a git working tree into atomic commits and write their messages.',
    '',
    'Message style for THIS repository:',
  ]

  if (format === 'conventional') {
    lines.push(
      '- Conventional Commits: `type(scope): subject`',
      `- Allowed types: ${config.message.types.join(', ')}`,
      '- Choose the type from what the change does, not from which files moved.',
    )

    if (style.commonTypes.length > 0) {
      lines.push(`- Types already common here: ${style.commonTypes.join(', ')}`)
    }

    const knownScopes = style.commonScopes.length
      ? ` Scopes already used here: ${style.commonScopes.join(', ')} — reuse these where they fit.`
      : ''

    if (config.message.scope === 'off') {
      lines.push('- Do not use scopes.')
    } else if (config.message.scope === 'required') {
      lines.push(`- Every subject must carry a scope.${knownScopes}`)
    } else {
      // Encourage, do not mandate. A forced scope with nothing meaningful to
      // name produces filler like `fix(fix):`, which is worse than no scope.
      lines.push(
        `- Prefer a scope naming the area touched: a package, module, route, or feature (for example \`feat(auth):\`).${knownScopes}`,
        '- Omit the scope rather than inventing a filler one. Never restate the type as the scope.',
      )
    }
  } else if (format === 'gitmoji') {
    lines.push('- Begin the subject with an appropriate gitmoji, then the summary.')
  } else {
    lines.push(
      '- Plain sentences, no type prefix. Capitalised, imperative mood.',
    )
  }

  lines.push(
    `- Keep subjects at or under ${config.message.maxTitleLength} characters.`,
    `- Write in ${config.message.language}.`,
  )

  if (style.samples.length > 0) {
    lines.push('', 'Real examples from this repository:')
    lines.push(...style.samples.map((sample) => `  ${sample}`))
  }

  const bodyRule =
    config.message.body === 'always'
      ? 'Always write a body.'
      : config.message.body === 'never'
        ? 'Never write a body; return an empty string for it.'
        : style.bodyRate > 0.5
          ? 'This repository usually writes bodies. Write one unless the change is trivial.'
          : 'Write a body only when the change is not self-explanatory.'

  lines.push(
    '',
    'Bodies:',
    `- ${bodyRule}`,
    config.message.bodyStyle === 'bullets'
      ? '- Use short bullet points ("- ...").'
      : '- Use short prose paragraphs.',
    '- Explain why the change was made, not a restatement of the diff.',
    '',
    'Rules you must not break:',
    '- Copy file paths EXACTLY as given. Never invent, abbreviate, or correct a path.',
    '- Assign every file to exactly one group. Do not omit any file.',
  )

  return lines.join('\n')
}

export function buildGroupingPrompt(
  files: FileChange[],
  diffs: FileDiff[],
  config: Config,
): string {
  return [
    GRANULARITY_GUIDANCE[config.grouping.granularity],
    `Produce at most ${config.grouping.maxCommits} groups.`,
    '',
    'Write only the subject line for each group; bodies come later.',
    '',
    `## Changed files (${files.length})`,
    renderFileTable(files),
    '',
    '## Diffs',
    renderDiffs(diffs),
  ].join('\n')
}

export function buildSinglePassPrompt(
  files: FileChange[],
  diffs: FileDiff[],
  config: Config,
): string {
  return [
    GRANULARITY_GUIDANCE[config.grouping.granularity],
    `Produce at most ${config.grouping.maxCommits} groups.`,
    '',
    'Write both the subject and the body for each group.',
    '',
    `## Changed files (${files.length})`,
    renderFileTable(files),
    '',
    '## Diffs',
    renderDiffs(diffs),
  ].join('\n')
}

export function buildMessagePrompt(
  title: string,
  files: string[],
  diffs: FileDiff[],
): string {
  return [
    'Write the final commit message for the group below.',
    `A provisional subject was suggested: "${title}". Improve it if the diff shows something better.`,
    '',
    `## Files in this commit (${files.length})`,
    ...files.map((file) => `- ${file}`),
    '',
    '## Full diff',
    renderDiffs(diffs),
  ].join('\n')
}

function renderFileTable(files: FileChange[]): string {
  return files
    .map((file) => {
      const size = file.collapsed
        ? `${file.fileCount} files`
        : `+${file.insertions}/-${file.deletions}`
      const rename = file.origPath ? ` (renamed from ${file.origPath})` : ''
      const staged = file.staged ? ' [staged]' : ''
      return `- ${file.path} — ${file.status}, ${size}${rename}${staged}`
    })
    .join('\n')
}

function renderDiffs(diffs: FileDiff[]): string {
  return diffs
    .map((diff) => {
      if (diff.omitted) {
        const reason =
          diff.omittedReason === 'binary'
            ? 'binary file, contents not shown'
            : diff.omittedReason === 'excluded'
              ? 'excluded from context by configuration'
              : 'omitted to stay within the context budget'
        return `### ${diff.path}\n(${reason})`
      }
      return `### ${diff.path}\n\`\`\`diff\n${diff.diff}\n\`\`\``
    })
    .join('\n\n')
}
