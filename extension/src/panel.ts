import * as vscode from 'vscode'
import { reduce, initialState, type CommitPlan, type WorkingTreeState } from 'unbraid'
import { toPlanView } from './view.js'

/** Extension → webview. */
type Outbound = { type: 'plan'; view: ReturnType<typeof toPlanView> }

/** Webview → extension. */
type Inbound =
  | { type: 'action'; action: Parameters<typeof reduce>[1] }
  | { type: 'commit' }
  | { type: 'cancel' }
  | { type: 'openFile'; path: string }

export interface ReviewResult {
  outcome: 'commit' | 'cancel'
  plan: CommitPlan
}

/**
 * Show the plan and let the user edit it.
 *
 * State lives here rather than in the webview, and every edit goes through
 * unbraid's own reducer — the same pure function the terminal UI uses, already
 * covered by its tests. The webview only draws what it is given and reports
 * intent back, so the two front ends cannot drift apart in behaviour.
 */
export async function reviewPlan(
  context: vscode.ExtensionContext,
  plan: CommitPlan,
  tree: WorkingTreeState,
): Promise<ReviewResult> {
  const panel = vscode.window.createWebviewPanel(
    'unbraid.review',
    'unbraid — review commits',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    },
  )

  let state = initialState(plan)
  const post = (message: Outbound) => panel.webview.postMessage(message)
  const render = () => post({ type: 'plan', view: toPlanView(state.plan, tree) })

  panel.webview.html = renderHtml(panel.webview, context.extensionUri)

  return new Promise<ReviewResult>((resolve) => {
    let settled = false
    const finish = (outcome: 'commit' | 'cancel') => {
      if (settled) return
      settled = true
      resolve({ outcome, plan: state.plan })
      panel.dispose()
    }

    panel.webview.onDidReceiveMessage((message: Inbound) => {
      switch (message.type) {
        case 'action':
          state = reduce(state, message.action)
          render()
          break
        case 'commit':
          finish('commit')
          break
        case 'cancel':
          finish('cancel')
          break
        case 'openFile':
          void openDiff(tree.root, message.path)
          break
      }
    })

    // Closing the tab is a cancellation, not a hang.
    panel.onDidDispose(() => finish('cancel'))

    render()
  })
}

/**
 * Open the file's diff in VS Code's own viewer.
 *
 * The panel deliberately renders no diff of its own — VS Code already has a
 * good one, and a worse copy inside a webview helps nobody.
 */
async function openDiff(root: string, path: string): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), path)
  try {
    await vscode.commands.executeCommand('git.openChange', uri)
  } catch {
    // Not a tracked change, or the git extension is unavailable.
    await vscode.window.showTextDocument(uri, { preview: true })
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'),
  )
  const styles = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'),
  )
  // A nonce so the CSP can allow exactly this one script and nothing else.
  const nonce = createNonce()

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${styles}" rel="stylesheet">
<title>unbraid</title>
</head>
<body>
<main id="root" aria-live="polite"></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
}

function createNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
