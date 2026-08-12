import * as vscode from 'vscode'
import type { SidebarMessage } from './sidebar.js'

export interface SettingsState {
  granularity: string
  hunks: boolean
  provider: string
  /** True when the repo's own config outranks what is shown here. */
  hasRepoConfig: boolean
}

/**
 * The settings form, as its own view at the bottom of the container.
 *
 * Separate from the main panel because views are ordered by declaration and
 * settings belong under the work, not above it. Collapsed by default: it is
 * read once and then rarely, so it should not push the file list down the
 * screen every session.
 */
export class SettingsView implements vscode.WebviewViewProvider {
  static readonly viewType = 'unbraid.settings'

  private view?: vscode.WebviewView
  private state: SettingsState | null = null

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
    view.webview.onDidReceiveMessage((message: SidebarMessage) => this.onMessage(message))
    view.onDidChangeVisibility(() => {
      if (view.visible) this.render()
    })
    this.render()
  }

  update(state: SettingsState): void {
    this.state = state
    this.render()
  }

  private render(): void {
    if (!this.view || !this.state) return
    this.view.webview.html = this.html(this.view.webview, this.state)
  }

  private html(webview: vscode.Webview, state: SettingsState): string {
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file))
    const nonce = createNonce()

    const option = (value: string, label: string, current: string) =>
      `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${media('sidebar.css')}" rel="stylesheet">
</head>
<body>
<div class="settings">
  <div class="field">
    <label for="granularity">Commit size</label>
    <select id="granularity">
      ${option('fine', 'One commit per file', state.granularity)}
      ${option('semantic', 'One per feature or fix', state.granularity)}
      ${option('coarse', 'Few, large commits', state.granularity)}
    </select>
  </div>

  <div class="field">
    <div class="field check">
      <input type="checkbox" id="hunks"${state.hunks ? ' checked' : ''}>
      <label for="hunks">Split files that mix concerns</label>
    </div>
    <span class="why">Lets one file's changes go into different commits.</span>
  </div>

  <div class="field">
    <label for="provider">AI provider</label>
    <select id="provider">
      ${option('auto', 'Automatic', state.provider)}
      ${option('claude-cli', 'Claude Code — free with a subscription', state.provider)}
      ${option('anthropic', 'Anthropic API', state.provider)}
      ${option('openai-compatible', 'OpenAI-compatible', state.provider)}
    </select>
  </div>

  <button class="wide secondary" id="setup" type="button">Set up a provider…</button>

  ${
    state.hasRepoConfig
      ? '<p class="why">This repository has its own <code>.unbraidrc.yaml</code>, which overrides these.</p>'
      : ''
  }
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  const send = (key, value) => vscode.postMessage({ type: 'setting', key, value })
  for (const id of ['granularity', 'provider']) {
    document.getElementById(id).addEventListener('change', (e) => send(id, e.target.value))
  }
  document.getElementById('hunks').addEventListener('change', (e) => send('hunks', e.target.checked))
  document.getElementById('setup').addEventListener('click', () =>
    vscode.postMessage({ type: 'setup' }))
</script>
</body>
</html>`
  }
}

function createNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
