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

const saved = vscode.getState() || { open: { staged: true, changes: true, settings: false } }
let open = saved.open

const persist = () => vscode.setState({ open })
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

  root.append(renderSettings())
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

function renderSettings() {
  const node = el('div', { class: 'section' })

  const head = el('button', { class: 'section-head', type: 'button' })
  head.append(el('span', { class: 'chevron' }, open.settings ? '⌄' : '›'))
  head.append(el('span', {}, 'Settings'))
  head.addEventListener('click', () => {
    open.settings = !open.settings
    persist()
    render()
  })
  node.append(head)

  if (!open.settings) return node

  const body = el('div', { class: 'settings' })

  body.append(
    select('granularity', 'Commit size', data.settings.granularity, [
      ['fine', 'One commit per file'],
      ['semantic', 'One per feature or fix'],
      ['coarse', 'Few, large commits'],
    ]),
    checkbox('hunks', 'Split files that mix concerns', data.settings.hunks,
      'Lets one file’s changes go into different commits.'),
    select('provider', 'AI provider', data.settings.provider, [
      ['auto', 'Automatic'],
      ['claude-cli', 'Claude Code (free with a subscription)'],
      ['anthropic', 'Anthropic API'],
      ['openai-compatible', 'OpenAI-compatible'],
    ]),
  )

  const setup = el('button', { class: 'wide secondary', type: 'button' }, 'Set up a provider…')
  setup.addEventListener('click', () => send({ type: 'setup' }))
  body.append(setup)

  if (data.hasRepoConfig) {
    body.append(
      el(
        'p',
        { class: 'why' },
        'This repository has its own .unbraidrc.yaml, which overrides these settings.',
      ),
    )
  }

  node.append(body)
  return node
}

function select(key, label, value, options) {
  const field = el('div', { class: 'field' })
  field.append(el('label', { for: `f-${key}` }, label))

  const node = el('select', { id: `f-${key}` })
  for (const [optionValue, optionLabel] of options) {
    const option = el('option', { value: optionValue }, optionLabel)
    if (optionValue === value) option.setAttribute('selected', 'true')
    node.append(option)
  }
  node.addEventListener('change', () =>
    send({ type: 'setting', key, value: node.value }),
  )

  field.append(node)
  return field
}

function checkbox(key, label, value, why) {
  const wrap = el('div', { class: 'field' })
  const row = el('div', { class: 'field check' })

  const node = el('input', { type: 'checkbox', id: `f-${key}` })
  if (value) node.setAttribute('checked', 'true')
  node.addEventListener('change', () =>
    send({ type: 'setting', key, value: node.checked }),
  )

  row.append(node, el('label', { for: `f-${key}` }, label))
  wrap.append(row, el('span', { class: 'why' }, why))
  return wrap
}

function iconButton(glyph, title, onClick, danger = false) {
  const node = el('button', {
    class: `icon-btn${danger ? ' danger' : ''}`,
    type: 'button',
    title,
    'aria-label': title,
  }, glyph)
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return node
}

/** Build an element. Text always goes through textContent, never innerHTML. */
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
