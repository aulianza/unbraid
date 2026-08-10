import picomatch from 'picomatch'
import type { FileChange } from '../core/engine/types.js'

export interface GuardResult {
  /** True when the run should stop and ask the user. */
  blocked: boolean
  /** Paths that look credential-shaped. */
  matches: string[]
}

/**
 * Stop before sending credential-shaped files to a provider that is off this
 * machine.
 *
 * Only remote providers trigger this. Sending a diff through the already
 * authenticated Claude CLI, or to a local Ollama, opens no new egress path, and
 * warning about it would train users to dismiss the warning.
 *
 * Note this guards the *context*, not the commit. A blocked run still commits
 * the file once the user says to proceed — unbraid is not in the business of
 * deciding what belongs in your repository.
 */
export function checkSecrets(
  files: FileChange[],
  patterns: string[],
  isRemoteProvider: boolean,
): GuardResult {
  if (!isRemoteProvider || patterns.length === 0) {
    return { blocked: false, matches: [] }
  }

  const isMatch = picomatch(patterns, { dot: true, basename: true })
  const matches = files.map((file) => file.path).filter((path) => isMatch(path))

  return { blocked: matches.length > 0, matches }
}

export function describeSecretWarning(
  matches: string[],
  providerName: string,
): string {
  return [
    `These files look like they hold credentials, and their contents would be sent to ${providerName}:`,
    '',
    ...matches.map((path) => `  ${path}`),
    '',
    'Options:',
    "  · Add them to context.exclude so they are committed but never sent",
    '  · Switch to a local provider (Ollama) or the Claude CLI',
    '  · Re-run with --no-guard if you are certain',
  ].join('\n')
}
