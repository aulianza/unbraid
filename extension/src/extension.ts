import * as vscode from 'vscode'
import {
  buildPlan,
  executePlan,
  checkSecrets,
  loadConfig,
  createGit,
} from 'unbraid'
import { readSettings } from './settings.js'
import { reviewPlan } from './panel.js'

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('unbraid', { log: true })
  context.subscriptions.push(output)

  context.subscriptions.push(
    vscode.commands.registerCommand('unbraid.createCommits', () =>
      createCommits(context, output),
    ),
    vscode.commands.registerCommand('unbraid.setup', runSetup),
  )
}

export function deactivate(): void {}

/**
 * Resolve which repository to act on.
 *
 * The active editor's folder is preferred so that in a multi-root workspace the
 * command acts on whatever the user is looking at, rather than always the first
 * folder — which would be quietly wrong half the time.
 */
function resolveFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri
  if (active) {
    const owning = vscode.workspace.getWorkspaceFolder(active)
    if (owning) return owning
  }
  return vscode.workspace.workspaceFolders?.[0]
}

async function createCommits(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const folder = resolveFolder()
  if (!folder) {
    void vscode.window.showErrorMessage('unbraid: open a folder first.')
    return
  }

  const cwd = folder.uri.fsPath

  try {
    const settings = vscode.workspace.getConfiguration('unbraid')
    const loaded = await loadConfig({ cwd, flags: readSettings(settings) as never })
    const config = loaded.config

    const built = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'unbraid',
        // An AI call can take a minute. A progress bar with no stop button is a
        // hang as far as the user is concerned.
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: 'Reading the working tree…' })

        return buildPlan({
          cwd,
          config,
          onTreeRead: (state, provider) => {
            output.info(
              `${state.files.length} changed · ${provider.name}/${provider.model}`,
            )
          },
          beforeModel: async (state, provider) => {
            if (token.isCancellationRequested) return false
            if (!config.guard.secrets) return true

            const guard = checkSecrets(
              state.files,
              config.guard.secretPatterns,
              provider.isRemote,
            )
            if (!guard.blocked) return true

            // Modal, because a webview cannot block and this decision must be
            // made before anything leaves the machine.
            const choice = await vscode.window.showWarningMessage(
              `These look like credential files and would be sent to ${provider.name}:\n\n${guard.matches.join('\n')}`,
              { modal: true },
              'Send anyway',
            )
            return choice === 'Send anyway'
          },
          onEvent: (event) => {
            if (token.isCancellationRequested) return
            if (event.type === 'grouping-start') {
              progress.report({
                message: event.singlePass
                  ? `Reading ${event.files} files and writing messages…`
                  : `Grouping ${event.files} files…`,
              })
            }
            if (event.type === 'grouping-done') {
              progress.report({ message: `Writing ${event.groups} commit messages…` })
            }
            if (event.type === 'degraded') {
              output.warn(`Grouping failed: ${event.reason}`)
            }
          },
        })
      },
    )

    const review = await reviewPlan(context, built.plan, built.state)
    if (review.outcome === 'cancel') {
      output.info('Cancelled. Nothing was committed.')
      return
    }

    const result = await executePlan(built.git, review.plan, {
      verify: config.execute.verify,
      ...(built.hunkContext ? { hunkContext: built.hunkContext } : {}),
      onCommit: (_id, sha, index, total) => output.info(`${index}/${total} ${sha.slice(0, 8)}`),
    })

    if (result.rolledBack) {
      const action = await vscode.window.showErrorMessage(
        `unbraid: ${result.rolledBack.reason}. Every commit was undone and your staging restored.`,
        'Show output',
      )
      if (action === 'Show output') output.show()
      return
    }

    void vscode.window.showInformationMessage(
      `unbraid created ${result.shas.length} commit${result.shas.length === 1 ? '' : 's'}.`,
    )
    // Make the Source Control view reflect reality immediately.
    await vscode.commands.executeCommand('git.refresh')
  } catch (error) {
    await reportFailure(error, cwd, output)
  }
}

/**
 * Turn a thrown error into something the user can act on.
 *
 * A missing provider is by far the most common first-run failure, and it has a
 * fix that is one button away, so it gets its own branch rather than being
 * shown as raw text.
 */
async function reportFailure(
  error: unknown,
  cwd: string,
  output: vscode.LogOutputChannel,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  output.error(message)

  if (/No AI provider available/i.test(message)) {
    const choice = await vscode.window.showErrorMessage(
      'unbraid has no AI provider configured yet.',
      'Set one up',
    )
    if (choice === 'Set one up') runSetup(cwd)
    return
  }

  const choice = await vscode.window.showErrorMessage(
    `unbraid: ${message.split('\n')[0]}`,
    'Show output',
  )
  if (choice === 'Show output') output.show()
}

/** Hand setup to the CLI's own wizard, which already verifies its result. */
function runSetup(cwd?: string): void {
  const terminal = vscode.window.createTerminal({
    name: 'unbraid setup',
    cwd: cwd ?? resolveFolder()?.uri.fsPath,
  })
  terminal.show()
  terminal.sendText('npx unbraid init')
}

// Re-exported for the smoke test, which has no other way to reach it.
export { resolveFolder, createGit }
