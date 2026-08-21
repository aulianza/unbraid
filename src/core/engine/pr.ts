import type { JsonSchema, Provider } from '../providers/types.js'
import type { Config } from '../config/schema.js'
import type { BranchSummary } from '../git/branch.js'
import { extractTicket } from '../git/branch.js'

/** Hard caps. A description nobody finishes reading has failed at its job. */
export const MAX_CHANGES = 6
export const MAX_CHANGE_LENGTH = 120
export const MAX_SUMMARY_LENGTH = 300

export const PR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'One line. What this branch delivers, not how.',
    },
    summary: {
      type: 'string',
      description:
        'Why this change exists, in one or two sentences. Not a list of what changed.',
    },
    changes: {
      type: 'array',
      maxItems: MAX_CHANGES,
      items: { type: 'string' },
      description:
        'Up to 6 bullets. One short line each, under 120 characters, no sub-clauses. Only changes a reviewer must know about. Omit refactors, formatting, and anything obvious from the diff.',
    },
    testing: {
      type: 'string',
      description:
        'Concrete steps a reviewer can follow to check this works, as short numbered lines. Empty string if the commits give no signal — never invent steps.',
    },
  },
  required: ['title', 'summary', 'changes', 'testing'],
  additionalProperties: false,
}

export interface PrDraft {
  title: string
  body: string
}

interface PrResponse {
  title: string
  summary: string
  changes: string[]
  testing: string
}

export function buildPrSystemPrompt(config: Config): string {
  return [
    'You write pull request descriptions.',
    '',
    'Your reader is a busy reviewer deciding whether to approve. They will skim.',
    'A description they abandon halfway is worse than a short one.',
    '',
    'Rules:',
    '- Title: one line, what this delivers.',
    '- Summary: one or two sentences on WHY this exists. Not a list of what changed.',
    `- Changes: at most ${MAX_CHANGES} bullets, one short line each, under ${MAX_CHANGE_LENGTH} characters.`,
    '- Testing: concrete steps to verify it. Numbered, terse, actionable.',
    '',
    'Leave out:',
    '- Anything obvious from reading the diff. They can read the diff.',
    '- Refactors, formatting, renames, lockfiles, and generated files.',
    '- Restating the file list, or the same point in two bullets.',
    '- Preamble such as "This PR ..." — start with the substance.',
    '',
    'Never invent testing steps, issue numbers, or context the commits do not support.',
    'If the commits give no signal about testing, return an empty string for it.',
    `Write in ${config.message.language}.`,
  ].join('\n')
}

export function buildPrPrompt(summary: BranchSummary): string {
  const merges =
    summary.merges.length > 0
      ? [
          '',
          '## Merged in from other branches',
          ...summary.merges.map((subject) => `- ${subject}`),
          '',
          'Their changes are NOT this branch\'s work and have been left out of',
          'the file list above. Do not describe them. Mention them in one bullet',
          'only if a reviewer would otherwise be confused by their presence.',
        ].join('\n')
      : ''

  const commits = summary.commits
    .map((commit) => {
      const body = commit.body ? `\n${indent(commit.body)}` : ''
      return `- ${commit.subject}${body}`
    })
    .join('\n')

  return [
    `Branch \`${summary.branch}\` → \`${summary.base}\``,
    `${summary.commits.length} commits · ${summary.filesChanged} files · +${summary.insertions}/-${summary.deletions}`,
    '',
    '## Commits (oldest first)',
    commits,
    '',
    '## Files changed',
    summary.diffstat || '(none)',
    merges,
  ].join('\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/**
 * Draft a pull request from a branch.
 *
 * Reads commits rather than the raw diff. A branch's commits are already a
 * human-authored summary of the diff — especially one unbraid wrote — so they
 * are both cheaper and more faithful to intent than re-deriving everything from
 * the changes themselves.
 */
export async function createPrDraft(
  summary: BranchSummary,
  config: Config,
  provider: Provider,
): Promise<PrDraft> {
  const response = await provider.complete<PrResponse>({
    system: buildPrSystemPrompt(config),
    prompt: buildPrPrompt(summary),
    schema: PR_SCHEMA,
    schemaName: 'pull_request',
  })

  return {
    title: applyTicket(response.title, summary.branch, config),
    body: renderBody(trimResponse(response), summary),
  }
}

/**
 * Turn a literal backslash-n into a real line break.
 *
 * Models double-escape newlines in JSON string fields often enough to matter:
 * the value arrives as the two characters `\` and `n`, which markdown renders
 * verbatim. Numbered testing steps come back as one long line reading
 * "1. Run the tests.\n2. Run init." Nothing in a pull request body wants a
 * literal backslash-n, so the substitution is safe.
 *
 * A doubled backslash is left alone. That is the one case where the text is
 * *about* an escape rather than containing one, and converting it would leave
 * a stray backslash behind.
 */
/**
 * Drop quote marks wrapping a whole field.
 *
 * The prompt asks for an empty string when there is nothing to say about
 * testing, and models answer that literally often enough that a real pull
 * request shipped with a Testing section containing `""`. Nothing in a title,
 * summary, or bullet is improved by the quotes that enclose all of it.
 */
function unquote(text: string): string {
  const trimmed = text.trim()
  const first = trimmed[0]
  if ((first === '"' || first === "'") && trimmed.length >= 2 && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function unescapeNewlines(text: string): string {
  return text.replace(/(?<!\\)\\r\\n|(?<!\\)\\n/g, '\n')
}

/**
 * Enforce the length caps in code.
 *
 * Schema `maxItems` and a prompt asking for brevity both help, and neither is a
 * guarantee. The caps exist because an unread description is a failed one.
 */
export function trimResponse(response: PrResponse): PrResponse {
  return {
    ...response,
    testing: unquote(unescapeNewlines(response.testing)),
    summary: truncate(unquote(unescapeNewlines(response.summary)), MAX_SUMMARY_LENGTH),
    changes: response.changes
      .map((change) => truncate(unquote(unescapeNewlines(change)), MAX_CHANGE_LENGTH))
      .filter((change) => change.length > 0)
      .slice(0, MAX_CHANGES),
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  // Cut at a word boundary so the result does not end mid-token.
  const cut = text.slice(0, limit)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

function dim(summary: BranchSummary): string {
  // "includes N merge(s)" read as though their diffs were in the totals. They
  // are not, and that is the more useful thing to say.
  const merged =
    summary.merges.length > 0
      ? ` · ${summary.merges.length} merge${summary.merges.length === 1 ? '' : 's'} not counted`
      : ''
  return `${summary.commits.length} commits · ${summary.filesChanged} files · +${summary.insertions}/-${summary.deletions}${merged}`
}

function applyTicket(title: string, branch: string, config: Config): string {
  const ticket = extractTicket(branch, config.message.ticketPattern)
  if (!ticket || title.includes(ticket)) return title
  return `${ticket} ${title}`
}

export function renderBody(
  response: PrResponse,
  summary: BranchSummary,
): string {
  const sections = [response.summary.trim(), '', '## Changes', '']

  sections.push(
    ...response.changes
      .filter((change) => change.trim().length > 0)
      .map((change) => `- ${change}`),
  )

  if (response.testing.trim()) {
    sections.push('', '## Testing', '', response.testing.trim())
  }

  sections.push(
    '',
    '---',
    `${dim(summary)}`,
  )

  return sections.join('\n')
}
