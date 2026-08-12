import * as vscode from 'vscode'
import type { RepoSummary } from './repo-state.js'

/**
 * The unbraid view in the activity bar.
 *
 * Its job is to be found. The Source Control title bar is contested space — with
 * GitLens or similar installed, a contributed button gets pushed into an
 * overflow menu nobody opens — so unbraid owns a surface instead of borrowing
 * one.
 */
export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewType = 'unbraid.sidebar'

  private view?: vscode.WebviewView
  private summary: RepoSummary | null = null

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] }

    view.webview.onDidReceiveMessage((message: { type: string }) => {
      if (message.type === 'createCommits') {
        void vscode.commands.executeCommand('unbraid.createCommits')
      }
      if (message.type === 'draftPr') {
        void vscode.commands.executeCommand('unbraid.draftPullRequest')
      }
      if (message.type === 'setup') {
        void vscode.commands.executeCommand('unbraid.setup')
      }
    })

    this.render()
  }

  update(summary: RepoSummary | null): void {
    this.summary = summary
    this.render()
  }

  private render(): void {
    if (!this.view) return
    this.view.webview.html = this.html()
  }

  private html(): string {
    const summary = this.summary
    const nonce = createNonce()

    const headline = !summary
      ? 'No git repository open'
      : summary.clean
        ? 'Nothing to commit'
        : `${summary.changed} changed file${summary.changed === 1 ? '' : 's'}`

    const detail = summary?.branch ? escape(summary.branch) : ''
    const staged =
      summary && summary.staged > 0
        ? `<p class="note">${summary.staged} already staged — those stay exactly as you set them.</p>`
        : ''
    const disabled = !summary || summary.clean ? 'disabled' : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px 14px;
    margin: 0;
  }
  h2 { font-size: 1.25em; margin: 0 0 2px; font-weight: 600; }
  .branch {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 0.88em;
    margin: 0 0 14px;
  }
  .note { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin: 0 0 12px; }
  button {
    display: block;
    width: 100%;
    margin-bottom: 6px;
    padding: 6px 10px;
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover:not([disabled]) { background: var(--vscode-button-hoverBackground); }
  button.secondary:hover:not([disabled]) { background: var(--vscode-button-secondaryHoverBackground); }
  button[disabled] { opacity: 0.45; cursor: default; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .hint {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    margin-top: 14px;
    line-height: 1.45;
  }
</style>
</head>
<body>
  <h2>${escape(headline)}</h2>
  ${detail ? `<p class="branch">on ${detail}</p>` : '<p class="branch"></p>'}
  ${staged}
  <button id="commits" ${disabled}>Preview commits</button>
  <button id="pr" class="secondary">Draft a pull request</button>
  <p class="hint">Groups your changes into commits and writes a message for each. Nothing is committed until you approve the plan.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    document.getElementById('commits').addEventListener('click', () =>
      vscode.postMessage({ type: 'createCommits' }))
    document.getElementById('pr').addEventListener('click', () =>
      vscode.postMessage({ type: 'draftPr' }))
  </script>
</body>
</html>`
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function createNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
