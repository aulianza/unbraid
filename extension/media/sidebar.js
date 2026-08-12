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

  if (data.groups) {
    root.append(
      section('staged', 'Staged', data.groups.staged, [
        iconButton('−', 'Unstage all', () =>
          send({ type: 'unstage', paths: data.groups.staged.map((r) => r.path) }),
        ),
      ]),
      section('changes', 'Changes', data.groups.changes, [
        iconButton('+', 'Stage all', () =>
          send({ type: 'stage', paths: data.groups.changes.map((r) => r.path) }),
        ),
        iconButton(
          '↺',
          'Discard all changes',
          () => send({ type: 'discard', paths: data.groups.changes.map((r) => r.path) }),
          true,
        ),
      ]),
    )
  }

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

  const preview = el('button', { class: 'wide', type: 'button' }, 'Preview commits')
  if (!summary || summary.clean) preview.setAttribute('disabled', 'true')
  else preview.addEventListener('click', () => send({ type: 'createCommits' }))
  head.append(preview)

  const pr = el('button', { class: 'wide secondary', type: 'button' }, 'Draft a pull request')
  pr.addEventListener('click', () => send({ type: 'draftPr' }))
  head.append(pr)

  return head
}

function section(key, label, rows, actions) {
  const node = el('div', { class: 'section' })

  const head = el('button', { class: 'section-head', type: 'button' })
  head.append(el('span', { class: 'chevron' }, open[key] ? '⌄' : '›'))
  head.append(el('span', {}, label))

  if (actions.length > 0 && rows.length > 0) {
    const group = el('div', { class: 'section-actions' })
    for (const action of actions) group.append(action)
    head.append(group)
  }
  head.append(el('span', { class: 'count' }, String(rows.length)))

  head.addEventListener('click', (event) => {
    // Let the stage/discard buttons act without also toggling the section.
    if (event.target !== head && event.target.closest('.icon-btn')) return
    open[key] = !open[key]
    persist()
    render()
  })
  node.append(head)

  if (!open[key]) return node

  if (rows.length === 0) {
    node.append(el('p', { class: 'empty' }, key === 'staged' ? 'Nothing staged.' : 'No changes.'))
    return node
  }

  const list = el('ul', { class: 'files' })
  for (const row of rows) list.append(renderRow(row, key))
  node.append(list)

  return node
}

function renderRow(row, key) {
  const item = el('li', { class: 'row', title: row.path })
  item.addEventListener('click', () => send({ type: 'openFile', path: row.path }))

  item.append(el('span', { class: 'name' }, row.name))
  if (row.collapsed) {
    item.append(el('span', { class: 'collapsed' }, `${row.collapsed} files`))
  }
  item.append(el('span', { class: 'dir' }, row.dir))

  const actions = el('div', { class: 'row-actions' })
  if (key === 'staged') {
    actions.append(iconButton('−', 'Unstage', () => send({ type: 'unstage', paths: [row.path] })))
  } else {
    actions.append(iconButton('+', 'Stage', () => send({ type: 'stage', paths: [row.path] })))
    actions.append(
      iconButton('↺', 'Discard changes', () => send({ type: 'discard', paths: [row.path] }), true),
    )
  }
  item.append(actions)

  item.append(el('span', { class: `letter ${row.letter}` }, row.letter))
  return item
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
