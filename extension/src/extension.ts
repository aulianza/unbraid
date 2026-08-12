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
import { SidebarView, type SidebarMessage } from './sidebar.js'
import { RepoWatcher } from './watcher.js'
import { statusLabel, statusTooltip, type RepoSummary } from './repo-state.js'
import { toFileGroups, untrackedPaths, describeDiscard } from './file-list.js'
import { ChangesTree, type Node } from './changes-tree.js'
import { gitFor, stage, unstage, discard, branchInfo, pull, pushCurrent, describeSync } from './git-ops.js'
import { readWorkingTree } from 'unbraid'

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('unbraid', { log: true })

  const tree = new ChangesTree()
  const sidebar = new SidebarView(context.extensionUri, (message) => {
    void handleSidebar(message, output, () => watcher.refresh())
  })
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    // Just left of the SCM branch indicator, where git information already lives.
    -1,
  )
  status.command = 'unbraid.createCommits'

  const watcher = new RepoWatcher(
    () => resolveFolder()?.uri.fsPath,
    async (summary) => {
      await refreshSidebar(sidebar, tree, summary)

      const enabled = vscode.workspace
        .getConfiguration('unbraid')
        .get<boolean>('statusBar', true)
      const label = statusLabel(summary)

      // An empty label means a clean tree: hide rather than show a zero, which
      // would be noise in a bar that is already crowded.
      if (!enabled || label === '') {
        status.hide()
      } else {
        status.text = `$(git-merge) ${label}`
        status.tooltip = statusTooltip(summary)
        status.show()
      }
    },
  )

  context.subscriptions.push(
    output,
    status,
    watcher,
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebar),
    vscode.window.createTreeView(ChangesTree.viewId, { treeDataProvider: tree }),

    // Tree actions. Each resolves its paths from what was clicked, then hands
    // off to the same handler the panel uses, so there is one path per verb.
    vscode.commands.registerCommand('unbraid.openChange', (path: string) =>
      handleSidebar({ type: 'openFile', path }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.stageFile', (node: Node) =>
      handleSidebar({ type: 'stage', paths: pathsOf(node) }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.unstageFile', (node: Node) =>
      handleSidebar({ type: 'unstage', paths: pathsOf(node) }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.discardFile', (node: Node) =>
      handleSidebar({ type: 'discard', paths: pathsOf(node) }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.stageAll', (node: Node) =>
      handleSidebar({ type: 'stage', paths: pathsOf(node) }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.unstageAll', (node: Node) =>
      handleSidebar({ type: 'unstage', paths: pathsOf(node) }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.discardAll', (node: Node) =>
      handleSidebar({ type: 'discard', paths: pathsOf(node) }, output, () => watcher.refresh()),
    ),
    vscode.commands.registerCommand('unbraid.createCommits', async () => {
      await createCommits(context, output, sidebar)
      await watcher.refresh()
    }),
    vscode.commands.registerCommand('unbraid.draftPullRequest', () => draftPullRequest()),
    vscode.commands.registerCommand('unbraid.setup', () => runSetup()),
  )

  watcher.start()
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
  sidebar: SidebarView,
): Promise<void> {
  const folder = resolveFolder()
  if (!folder) {
    void vscode.window.showErrorMessage('unbraid: open a folder first.')
    return
  }

  const cwd = folder.uri.fsPath
  sidebar.setBusy('Reading your changes…')

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
            sidebar.setBusy(`Reading ${state.files.length} files…`)
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
              const message = event.singlePass
                ? `Writing commit messages…`
                : `Grouping ${event.files} files…`
              progress.report({ message })
              sidebar.setBusy(message)
            }
            if (event.type === 'grouping-done') {
              const message = `Writing ${event.groups} commit messages…`
              progress.report({ message })
              sidebar.setBusy(message)
            }
            if (event.type === 'degraded') {
              output.warn(`Grouping failed: ${event.reason}`)
            }
          },
        })
      },
    )

    sidebar.setBusy('Waiting for your review…')
    const review = await reviewPlan(context, built.plan, built.state)
    if (review.outcome === 'cancel') {
      output.info('Cancelled. Nothing was committed.')
      return
    }

    sidebar.setBusy('Creating commits…')
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
  } finally {
    // Every path out of here — cancelled, failed, rolled back, or done — has to
    // release the button, or it stays stuck mid-sweep forever.
    sidebar.setBusy(null)
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

/**
 * Pull request drafting runs in a terminal rather than a panel.
 *
 * `unbraid pr` already prints a reviewable draft and can open the browser or
 * the GitHub CLI; wrapping that in a webview would add a step without adding
 * anything.
 */
function draftPullRequest(): void {
  const cwd = resolveFolder()?.uri.fsPath
  if (!cwd) {
    void vscode.window.showErrorMessage('unbraid: open a folder first.')
    return
  }
  const terminal = vscode.window.createTerminal({ name: 'unbraid pr', cwd })
  terminal.show()
  terminal.sendText('npx unbraid pr --web')
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

/**
 * Gather everything the panel shows.
 *
 * Read in one place so the file list, branch state, and settings can never
 * disagree with each other on screen.
 */
/** Paths a tree action applies to: one file, or every file in a section. */
function pathsOf(node: Node | undefined): string[] {
  if (!node) return []
  return node.kind === 'group' ? node.rows.map((row) => row.path) : [node.row.path]
}

async function refreshSidebar(
  sidebar: SidebarView,
  tree: ChangesTree,
  summary: RepoSummary | null,
): Promise<void> {
  const cwd = resolveFolder()?.uri.fsPath
  const settings = vscode.workspace.getConfiguration('unbraid')

  const base = {
    summary,
    busy: null,
    settings: {
      granularity: settings.get<string>('granularity', 'semantic'),
      hunks: settings.get<boolean>('hunks', false),
      provider: settings.get<string>('provider', 'auto'),
    },
  }

  if (!cwd || !summary) {
    tree.update(null, null)
    sidebar.update({
      ...base,
      groups: null,
      branch: null,
      syncLabel: '',
      hasRepoConfig: false,
    })
    return
  }

  try {
    const git = gitFor(cwd)
    const loaded = await loadConfig({ cwd })
    const state = await readWorkingTree(git, {
      expandUntrackedDirsUpTo: loaded.config.grouping.expandUntrackedDirsUpTo,
    })
    const branch = await branchInfo(git)

    const groups = toFileGroups(state)
    tree.update(groups, state.root)

    sidebar.update({
      ...base,
      groups,
      branch,
      syncLabel: describeSync(branch),
      // Worth surfacing: a repo config silently outranks the settings above it.
      hasRepoConfig: loaded.filesRead.some((file) => file.includes('.unbraidrc')),
    })
  } catch {
    tree.update(null, null)
    sidebar.update({ ...base, groups: null, branch: null, syncLabel: '', hasRepoConfig: false })
  }
}

async function handleSidebar(
  message: SidebarMessage,
  output: vscode.LogOutputChannel,
  refresh: () => Promise<void>,
): Promise<void> {
  const cwd = resolveFolder()?.uri.fsPath

  switch (message.type) {
    case 'createCommits':
      return void vscode.commands.executeCommand('unbraid.createCommits')
    case 'draftPr':
      return void vscode.commands.executeCommand('unbraid.draftPullRequest')
    case 'setup':
      return void vscode.commands.executeCommand('unbraid.setup')

    case 'setting': {
      // Global rather than workspace, so a preference follows the user between
      // projects instead of being set once and forgotten.
      await vscode.workspace
        .getConfiguration('unbraid')
        .update(message.key, message.value, vscode.ConfigurationTarget.Global)
      return refresh()
    }

    case 'openFile': {
      if (!cwd) return
      const uri = vscode.Uri.joinPath(vscode.Uri.file(cwd), message.path)
      try {
        await vscode.commands.executeCommand('git.openChange', uri)
      } catch {
        await vscode.window.showTextDocument(uri, { preview: true })
      }
      return
    }

    case 'stage':
    case 'unstage': {
      if (!cwd) return
      try {
        const git = gitFor(cwd)
        if (message.type === 'stage') await stage(git, message.paths)
        else await unstage(git, message.paths)
      } catch (error) {
        output.error(String(error))
        void vscode.window.showErrorMessage(`unbraid: ${describe(error)}`)
      }
      return refresh()
    }

    case 'discard': {
      if (!cwd || message.paths.length === 0) return
      const git = gitFor(cwd)

      // The only destructive action in the panel, and the one place unbraid's
      // usual promise does not hold — so it is the one place that asks.
      const state = await readWorkingTree(git)
      const groups = toFileGroups(state)
      const rows = [...groups.staged, ...groups.changes].filter((row) =>
        message.paths.includes(row.path),
      )

      const choice = await vscode.window.showWarningMessage(
        describeDiscard(rows),
        { modal: true },
        'Discard',
      )
      if (choice !== 'Discard') return

      try {
        await discard(git, message.paths, untrackedPaths(groups))
      } catch (error) {
        output.error(String(error))
        void vscode.window.showErrorMessage(`unbraid: ${describe(error)}`)
      }
      return refresh()
    }

    case 'sync': {
      if (!cwd) return
      try {
        const git = gitFor(cwd)
        const info = await branchInfo(git)
        if (info.behind > 0) await pull(git)
        if (info.ahead > 0 || !info.upstream) await pushCurrent(git)
      } catch (error) {
        output.error(String(error))
        void vscode.window.showErrorMessage(`unbraid: ${describe(error)}`)
      }
      return refresh()
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}
