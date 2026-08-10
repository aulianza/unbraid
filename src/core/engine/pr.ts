import type { JsonSchema, Provider } from '../providers/types.js'
import type { Config } from '../config/schema.js'
import type { BranchSummary } from '../git/branch.js'
import { extractTicket } from '../git/branch.js'

export const PR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'One line. What this branch delivers, not how.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentences a reviewer reads first.',
    },
    changes: {
      type: 'array',
      items: { type: 'string' },
      description: 'The substantive changes, one bullet each. No trivia.',
    },
    testing: {
      type: 'string',
      description:
        'How this was or should be verified. Empty string if the commits give no signal.',
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
    'You write pull request descriptions from a branch of commits.',
    '',
    'Write for a reviewer who has not seen this work and has limited time.',
    '- The title states what the branch delivers, in one line.',
    '- The summary is one or two sentences of context: what changed and why.',
    '- Bullets cover substantive changes only. Skip formatting, lockfiles, and renames.',
    '- Explain intent. A reviewer can read the diff; they cannot read your reasoning.',
    '- Never invent testing, issue numbers, or context the commits do not support.',
    `- Write in ${config.message.language}.`,
  ].join('\n')
}

export function buildPrPrompt(summary: BranchSummary): string {
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
    body: renderBody(response, summary),
  }
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
    '',
    `${summary.commits.length} commits · ${summary.filesChanged} files changed · +${summary.insertions}/-${summary.deletions}`,
  )

  return sections.join('\n')
}
