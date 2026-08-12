import * as vscode from 'vscode'
import type { RepoSummary } from './repo-state.js'
import type { BranchInfo } from './git-ops.js'
import type { FileGroups } from './file-list.js'

export interface SidebarState {
  summary: RepoSummary | null
  groups: FileGroups | null
  branch: BranchInfo | null
  syncLabel: string
  settings: { granularity: string; hunks: boolean; provider: string }
  /** True when the repo has its own config, which overrides the settings shown. */
  hasRepoConfig: boolean
  /**
   * What unbraid is currently doing, or null when idle.
   *
   * The progress notification appears in the corner of the window, far from the
   * button that was pressed — easy to miss entirely, which reads as the click
   * having done nothing. The button has to react where the user is looking.
   */
  busy: string | null
}

export type SidebarMessage =
  | { type: 'createCommits' }
  | { type: 'draftPr' }
  | { type: 'setup' }
  | { type: 'sync' }
  | { type: 'openFile'; path: string }
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'discard'; paths: string[] }
  | { type: 'setting'; key: string; value: string | boolean }

/**
 * The unbraid view in the activity bar.
 *
 * Owns a surface rather than borrowing one: a button contributed to the Source
 * Control title bar gets pushed into an overflow menu on any real setup, and a
 * button nobody can find is a button that does not exist.
 *
 * The webview holds no git state and performs no git operations — it renders
 * what it is handed and posts intent back, so every mutation goes through one
 * audited path in the extension.
 */
export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewType = 'unbraid.sidebar'

  private view?: vscode.WebviewView
  private state: SidebarState | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: SidebarMessage) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((message: SidebarMessage) => this.onMessage(message))

    // The webview is torn down when hidden, so it needs its data again on return.
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post()
    })

    this.post()
  }

  update(state: SidebarState): void {
    this.state = state
    this.post()
  }

  /**
   * Set the working state without waiting for a full refresh.
   *
   * Refreshing reads the tree and shells out to git, which is far too slow to
   * be the thing that acknowledges a click.
   */
  setBusy(label: string | null): void {
    if (!this.state) return
    this.state = { ...this.state, busy: label }
    this.post()
  }

  private post(): void {
    if (this.view && this.state) {
      void this.view.webview.postMessage({ type: 'state', value: this.state })
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file))
    const nonce = createNonce()

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${media('sidebar.css')}" rel="stylesheet">
<title>unbraid</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${media('sidebar.js')}"></script>
</body>
</html>`
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
