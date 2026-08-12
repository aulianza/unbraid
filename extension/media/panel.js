// @ts-check
/**
 * The review panel.
 *
 * Deliberately dumb: it renders the view it is handed and reports intent back.
 * Every edit is a reducer action applied on the extension side by unbraid's own
 * reducer, the same one the terminal UI uses, so the two front ends cannot drift
 * apart in behaviour.
 */

const vscode = acquireVsCodeApi()
const root = /** @type {HTMLElement} */ (document.getElementById('root'))

/** @type {any} */
let view = { commits: [], unassigned: [], totalFiles: 0 }

window.addEventListener('message', (event) => {
  if (event.data?.type === 'plan') {
    view = event.data.view
    render()
  }
})

const send = (message) => vscode.postMessage(message)
const act = (action) => send({ type: 'action', action })

/** Move the cursor to a commit, then apply an action that operates on it. */
const actOn = (index, action) => {
  act({ type: 'cursor', delta: index - cursor })
  cursor = index
  act(action)
}

let cursor = 0

function render() {
  root.replaceChildren()
  if (view.commits.length === 0) {
    root.append(el('p', { class: 'muted' }, 'No commits in this plan.'))
    return
  }

  root.append(
    el(
      'div',
      { class: 'summary' },
      icon('git-commit'),
      el('strong', {}, `${view.commits.length} commit${view.commits.length === 1 ? '' : 's'}`),
      el('span', { class: 'muted' }, `from ${view.totalFiles} file${view.totalFiles === 1 ? '' : 's'}`),
    ),
  )

  view.commits.forEach((commit, index) => root.append(renderCommit(commit, index)))

  if (view.unassigned.length > 0) {
    root.append(
      el(
        'div',
        { class: 'unassigned' },
        `${view.unassigned.length} file${view.unassigned.length === 1 ? '' : 's'} not assigned to any commit: ${view.unassigned.join(', ')}`,
      ),
    )
  }

  root.append(
    el(
      'div',
      { class: 'footer' },
      (() => {
        const commit = button('primary', '', () => send({ type: 'commit' }))
        commit.append(icon('check'))
        commit.append(
          document.createTextNode(
            ` Commit ${view.commits.length === 1 ? 'it' : `all ${view.commits.length}`}`,
          ),
        )
        return commit
      })(),
      button('action', 'Cancel', () => send({ type: 'cancel' })),
      el('span', { class: 'hint' }, 'Your files are never modified — only staged and committed.'),
    ),
  )
}

function renderCommit(commit, index) {
  const node = el('section', { class: 'commit' })

  const title = el('input', {
    class: 'title',
    value: commit.title,
    'aria-label': `Commit ${index + 1} message`,
  })
  // Commit on blur or Enter rather than per keystroke: one reducer action per
  // edit, not one per character.
  const save = () => {
    if (title.value.trim() && title.value !== commit.title) {
      actOn(index, { type: 'begin-edit' })
      // Replace the draft wholesale instead of replaying keystrokes.
      for (let i = 0; i < commit.title.length; i++) {
        act({ type: 'edit-key', input: '', backspace: true })
      }
      act({ type: 'edit-key', input: title.value.trim(), backspace: false })
      act({ type: 'commit-edit' })
    }
  }
  title.addEventListener('blur', save)
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      title.blur()
    }
  })

  const titleArea = el('div', { class: 'title-area' }, title)
  if (commit.body) titleArea.append(el('div', { class: 'body' }, commit.body))

  node.append(
    el(
      'div',
      { class: 'commit-head' },
      el(
        'span',
        { class: 'marker' },
        icon(commit.locked ? 'lock' : 'git-commit'),
        el('span', { class: 'index' }, String(index + 1)),
      ),
      titleArea,
      commit.locked ? el('span', { class: 'badge' }, 'pre-staged') : null,
      el('span', { class: 'meta' }, commit.fileSummary),
    ),
  )

  for (const warning of commit.warnings) {
    node.append(el('div', { class: 'warning' }, icon('warning'), el('span', {}, warning)))
  }

  const files = el('ul', { class: 'files' })
  for (const file of commit.files) {
    const item = el('li', {})
    const link = button('file', '', () => send({ type: 'openFile', path: file.path }))
    link.append(icon(file.partial ? 'diff' : 'file'))
    link.append(document.createTextNode(file.path))
    if (file.partial) {
      link.append(el('span', { class: 'partial' }, ` (${file.partial} of its changes)`))
    } else if (file.collapsed) {
      link.append(el('span', { class: 'count' }, ` (${file.collapsed} files)`))
    }
    item.append(link)
    files.append(item)
  }
  node.append(files)

  node.append(
    el(
      'div',
      { class: 'actions' },
      iconAction('arrow-up', 'Move up', () => actOn(index, { type: 'move-commit', delta: -1 }), index === 0),
      iconAction(
        'arrow-down',
        'Move down',
        () => actOn(index, { type: 'move-commit', delta: 1 }),
        index === view.commits.length - 1,
      ),
      iconAction('fold-up', 'Merge into the commit above', () => actOn(index, { type: 'merge-up' }), index === 0 || commit.locked),
      iconAction('trash', 'Remove — its files go back to the pile', () => actOn(index, { type: 'dissolve' }), commit.locked),
    ),
  )

  return node
}

/** A codicon. VS Code's own icon font, the one thing a webview can use. */
function icon(name) {
  return el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' })
}

/** An icon button that still names itself for screen readers and on hover. */
function iconAction(name, title, onClick, disabled = false) {
  const node = el('button', { class: 'action icon', type: 'button', title, 'aria-label': title })
  node.append(icon(name))
  if (disabled) node.setAttribute('disabled', 'true')
  else node.addEventListener('click', onClick)
  return node
}

function button(className, label, onClick, disabled = false) {
  const node = el('button', { class: className, type: 'button' }, label)
  if (disabled) node.setAttribute('disabled', 'true')
  else node.addEventListener('click', onClick)
  return node
}

/** Build an element. Text is set via textContent, never innerHTML. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (key === 'value') node.value = value
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}
