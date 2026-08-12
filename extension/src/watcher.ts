import * as vscode from 'vscode'
import { createGit, readWorkingTree, loadConfig } from 'unbraid'
import { summariseRepo, same, type RepoSummary } from './repo-state.js'

/**
 * Keep the sidebar and status bar in step with the working tree.
 *
 * Reading the tree shells out to git, so it is debounced and only ever runs on a
 * real signal: a saved file, a change under .git, or the window regaining focus
 * after work happened in a terminal. Polling on a timer would burn cycles all
 * day for a number that changes a few times an hour.
 */
export class RepoWatcher {
  private timer: NodeJS.Timeout | undefined
  private disposables: vscode.Disposable[] = []
  private current: RepoSummary | null = null

  constructor(
    private readonly getCwd: () => string | undefined,
    private readonly onChange: (summary: RepoSummary | null) => void,
    private readonly debounceMs = 700,
  ) {}

  start(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*')
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.schedule()),
      watcher.onDidCreate(() => this.schedule()),
      watcher.onDidDelete(() => this.schedule()),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      // Commits and stages often happen in a terminal; refocusing the window is
      // the moment the user expects the count to be right again.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.schedule()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
    )

    this.schedule(0)
  }

  private schedule(delay = this.debounceMs): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), delay)
  }

  async refresh(): Promise<void> {
    const cwd = this.getCwd()
    if (!cwd) return this.emit(null)

    try {
      const { config } = await loadConfig({ cwd })
      const state = await readWorkingTree(createGit(cwd), {
        expandUntrackedDirsUpTo: config.grouping.expandUntrackedDirsUpTo,
      })
      this.emit(summariseRepo(state))
    } catch {
      // Not a repository, mid-rebase, or git unavailable. The panel says
      // nothing rather than showing an error for a background refresh.
      this.emit(null)
    }
  }

  private emit(summary: RepoSummary | null): void {
    // Skip identical updates so the webview is not re-rendered on every keystroke.
    if (same(this.current, summary)) return
    this.current = summary
    this.onChange(summary)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables = []
  }
}
