// @ts-check
/**
 * The unbraid panel.
 *
 * Renders what it is handed and reports intent; every git operation happens on
 * the extension side. Collapsed/expanded section state is kept in the webview's
 * own persisted state so it survives the panel being hidden and rebuilt.
 */

const vscode = acquireVsCodeApi()
const root = /** @type {HTMLElement} */ (document.getElementById('root'))

/** @type {any} */
let data = null

const send = (message) => vscode.postMessage(message)

window.addEventListener('message', (event) => {
  if (event.data?.type === 'state') {
    data = event.data.value
    render()
  }
})

function render() {
  root.replaceChildren()
  if (!data) return

  root.append(renderHead())
}

function renderHead() {
  const head = el('div', { class: 'head' })
  const summary = data.summary

  const headline = !summary
    ? 'No git repository open'
    : summary.clean
      ? 'Nothing to commit'
      : `${summary.changed} changed file${summary.changed === 1 ? '' : 's'}`

  head.append(el('h2', {}, headline))

  const branch = el('div', { class: 'branch' })
  if (data.branch?.branch) {
    branch.append(el('span', { class: 'name' }, data.branch.branch))
    branch.append(el('span', {}, '·'))
    const sync = el('button', { class: 'sync', type: 'button' }, data.syncLabel)
    sync.title = 'Push or pull to match the remote'
    sync.addEventListener('click', () => send({ type: 'sync' }))
    branch.append(sync)
  }
  head.append(branch)

  const busy = data.busy

  const preview = el(
    'button',
    { class: `wide${busy ? ' busy' : ''}`, type: 'button' },
    busy ?? 'Preview commits',
  )
  if (busy || !summary || summary.clean) preview.setAttribute('disabled', 'true')
  else {
    preview.addEventListener('click', () => {
      // Acknowledge the click immediately. The extension confirms with the real
      // label a moment later, but the button must not sit inert until then.
      preview.textContent = 'Reading your changes…'
      preview.setAttribute('disabled', 'true')
      preview.classList.add('busy')
      send({ type: 'createCommits' })
    })
  }
  head.append(preview)

  const pr = el('button', { class: 'wide secondary', type: 'button' }, 'Draft a pull request')
  if (busy) pr.setAttribute('disabled', 'true')
  else pr.addEventListener('click', () => send({ type: 'draftPr' }))
  head.append(pr)

  return head
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === 'checked' || key === 'selected') node[key] = true
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}
