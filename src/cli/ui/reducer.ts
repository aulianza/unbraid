import type { CommitPlan, PlannedCommit } from '../../core/engine/types.js'

export interface EditorState {
  plan: CommitPlan
  /** Index into `plan.commits`. */
  cursor: number
  /** Commit ids whose file lists are expanded. */
  expanded: Set<string>
  /** Set while a title is being edited. */
  editing: { id: string; draft: string } | null
  /** Set once the user has decided; the render loop exits on this. */
  outcome: 'pending' | 'commit' | 'cancel'
  /** Transient message shown in the footer. */
  notice: string | null
}

export type EditorAction =
  | { type: 'cursor'; delta: number }
  | { type: 'toggle-expand' }
  | { type: 'move-commit'; delta: number }
  | { type: 'merge-up' }
  | { type: 'dissolve' }
  | { type: 'begin-edit' }
  | { type: 'edit-key'; input: string; backspace: boolean }
  | { type: 'commit-edit' }
  | { type: 'cancel-edit' }
  | { type: 'approve' }
  | { type: 'cancel' }

export function initialState(plan: CommitPlan): EditorState {
  return {
    plan,
    cursor: 0,
    expanded: new Set(),
    editing: null,
    outcome: 'pending',
    notice: null,
  }
}

/**
 * All review-screen behaviour, as a pure function.
 *
 * Keeping this out of the React component means the interesting logic — merging,
 * reordering, dissolving a commit back into `unassigned` — is tested directly,
 * without rendering anything or simulating keystrokes.
 */
export function reduce(state: EditorState, action: EditorAction): EditorState {
  const commits = state.plan.commits

  switch (action.type) {
    case 'cursor': {
      if (commits.length === 0) return state
      const next = clamp(state.cursor + action.delta, 0, commits.length - 1)
      return { ...state, cursor: next, notice: null }
    }

    case 'toggle-expand': {
      const current = commits[state.cursor]
      if (!current) return state
      const expanded = new Set(state.expanded)
      if (expanded.has(current.id)) expanded.delete(current.id)
      else expanded.add(current.id)
      return { ...state, expanded }
    }

    case 'move-commit': {
      const from = state.cursor
      const to = from + action.delta
      if (to < 0 || to >= commits.length) return state

      const reordered = [...commits]
      const [moved] = reordered.splice(from, 1)
      reordered.splice(to, 0, moved!)

      return {
        ...state,
        plan: { ...state.plan, commits: reordered },
        cursor: to,
        notice: null,
      }
    }

    case 'merge-up': {
      if (state.cursor === 0) return state
      const target = commits[state.cursor - 1]!
      const source = commits[state.cursor]!

      // A locked group is the user's own staging. Folding other files into it
      // would silently change what they deliberately staged.
      if (target.locked || source.locked) {
        return { ...state, notice: 'Pre-staged commits cannot be merged.' }
      }

      const merged: PlannedCommit = {
        ...target,
        files: [...target.files, ...source.files],
        warnings: [...target.warnings, ...source.warnings],
        body: joinBodies(target.body, source.body),
      }

      const next = [...commits]
      next.splice(state.cursor - 1, 2, merged)

      return {
        ...state,
        plan: { ...state.plan, commits: next },
        cursor: state.cursor - 1,
        notice: `Merged into "${truncate(target.title)}".`,
      }
    }

    case 'dissolve': {
      const current = commits[state.cursor]
      if (!current) return state
      if (current.locked) {
        return { ...state, notice: 'Pre-staged commits cannot be removed.' }
      }

      const next = commits.filter((_, index) => index !== state.cursor)
      return {
        ...state,
        plan: {
          ...state.plan,
          commits: next,
          // Files go to unassigned, never away. Dropping them here would be the
          // one way this tool could lose work.
          unassigned: [...state.plan.unassigned, ...current.files],
        },
        cursor: clamp(state.cursor, 0, Math.max(0, next.length - 1)),
        notice: `${current.files.length} file(s) moved to unassigned.`,
      }
    }

    case 'begin-edit': {
      const current = commits[state.cursor]
      if (!current) return state
      return { ...state, editing: { id: current.id, draft: current.title } }
    }

    case 'edit-key': {
      if (!state.editing) return state
      const draft = action.backspace
        ? state.editing.draft.slice(0, -1)
        : state.editing.draft + action.input
      return { ...state, editing: { ...state.editing, draft } }
    }

    case 'commit-edit': {
      if (!state.editing) return state
      const { id, draft } = state.editing
      const title = draft.trim()
      if (title.length === 0) {
        return { ...state, editing: null, notice: 'Title cannot be empty.' }
      }

      return {
        ...state,
        plan: {
          ...state.plan,
          commits: commits.map((commit) =>
            commit.id === id ? { ...commit, title } : commit,
          ),
        },
        editing: null,
        notice: null,
      }
    }

    case 'cancel-edit':
      return { ...state, editing: null }

    case 'approve': {
      if (commits.every((commit) => commit.files.length === 0)) {
        return { ...state, notice: 'Nothing to commit.' }
      }
      return { ...state, outcome: 'commit' }
    }

    case 'cancel':
      return { ...state, outcome: 'cancel' }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function joinBodies(a: string | null, b: string | null): string | null {
  if (a && b) return `${a}\n${b}`
  return a ?? b
}

function truncate(text: string, max = 40): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
