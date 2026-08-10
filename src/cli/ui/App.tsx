import React, { useReducer } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { reduce, initialState, type EditorState } from './reducer.js'
import { describeFileCount } from '../render.js'
import type { CommitPlan, WorkingTreeState } from '../../core/engine/types.js'

export interface ReviewProps {
  plan: CommitPlan
  state: WorkingTreeState
  onDone: (outcome: 'commit' | 'cancel', plan: CommitPlan) => void
}

/**
 * The review screen.
 *
 * Deliberately thin: every state transition lives in `reduce`, so this component
 * only maps keystrokes to actions and state to output. Terminal height is
 * respected by windowing the list rather than letting it scroll away.
 */
export function Review({ plan, state: tree, onDone }: ReviewProps) {
  const [editor, dispatch] = useReducer(reduce, initialState(plan))
  const { exit } = useApp()

  useInput((input, key) => {
    if (editor.outcome !== 'pending') return

    if (editor.editing) {
      if (key.return) return dispatch({ type: 'commit-edit' })
      if (key.escape) return dispatch({ type: 'cancel-edit' })
      if (key.backspace || key.delete) {
        return dispatch({ type: 'edit-key', input: '', backspace: true })
      }
      if (input && !key.ctrl && !key.meta) {
        return dispatch({ type: 'edit-key', input, backspace: false })
      }
      return
    }

    if (key.upArrow || input === 'k') return dispatch({ type: 'cursor', delta: -1 })
    if (key.downArrow || input === 'j') return dispatch({ type: 'cursor', delta: 1 })
    if (input === ' ') return dispatch({ type: 'toggle-expand' })
    if (input === 'e' || key.return) return dispatch({ type: 'begin-edit' })
    if (input === 'K') return dispatch({ type: 'move-commit', delta: -1 })
    if (input === 'J') return dispatch({ type: 'move-commit', delta: 1 })
    if (input === 'm') return dispatch({ type: 'merge-up' })
    if (input === 'd') return dispatch({ type: 'dissolve' })
    if (input === 'c') return dispatch({ type: 'approve' })
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      return dispatch({ type: 'cancel' })
    }
  })

  // Report the decision exactly once, then unmount.
  React.useEffect(() => {
    if (editor.outcome === 'pending') return
    onDone(editor.outcome, editor.plan)
    exit()
  }, [editor.outcome])

  if (editor.outcome !== 'pending') return null

  const rows = Math.max((process.stdout.rows ?? 24) - 10, 6)
  const window = windowAround(editor.cursor, editor.plan.commits.length, rows)

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>
          {editor.plan.commits.length} commits from{' '}
          {describeFileCount(
            editor.plan.commits.flatMap((commit) => commit.files),
            tree,
          )}
        </Text>
      </Box>

      {editor.plan.commits.slice(window.start, window.end).map((commit, offset) => {
        const index = window.start + offset
        const selected = index === editor.cursor
        const isEditing = editor.editing?.id === commit.id

        return (
          <Box key={commit.id} flexDirection="column">
            <Text>
              <Text color={selected ? 'cyan' : undefined}>
                {selected ? '▸ ' : '  '}
              </Text>
              <Text dimColor>{String(index + 1).padStart(2)} </Text>
              {isEditing ? (
                <Text backgroundColor="cyan" color="black">
                  {editor.editing!.draft}▏
                </Text>
              ) : (
                <Text bold={selected}>{commit.title}</Text>
              )}
              {commit.locked ? <Text color="yellow"> [pre-staged]</Text> : null}
              <Text dimColor>
                {'  '}
                {describeFileCount(commit.files, tree)}
              </Text>
            </Text>

            {editor.expanded.has(commit.id)
              ? commit.files.map((file) => {
                  const taken = (commit.hunks ?? []).filter(
                    (id) => id.slice(0, id.lastIndexOf('#')) === file,
                  ).length
                  return (
                    <Text key={file} dimColor>
                      {'      · '}
                      {file}
                      {taken > 0 ? (
                        <Text color="yellow">{` (${taken} of its changes)`}</Text>
                      ) : null}
                    </Text>
                  )
                })
              : null}

            {commit.warnings.map((warning) => (
              <Text key={warning} color="yellow">
                {'      ! '}
                {warning}
              </Text>
            ))}
          </Box>
        )
      })}

      {editor.plan.unassigned.length > 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">
            {editor.plan.unassigned.length} unassigned file(s) — press d on a commit to
            add more
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {editor.notice ? <Text color="yellow">{editor.notice}</Text> : null}
        <Text dimColor>
          {editor.editing
            ? 'enter save · esc cancel'
            : '↑↓ move · space files · e edit · J/K reorder · m merge up · d remove · c commit · q quit'}
        </Text>
      </Box>
    </Box>
  )
}

/** Keep the cursor visible without letting a long plan scroll off screen. */
export function windowAround(
  cursor: number,
  total: number,
  size: number,
): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total }
  const half = Math.floor(size / 2)
  const start = Math.min(Math.max(cursor - half, 0), total - size)
  return { start, end: start + size }
}

export type { EditorState }
