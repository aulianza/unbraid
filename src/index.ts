/**
 * Library entry point.
 *
 * Everything a front end needs to drive unbraid without going through the CLI —
 * this is what the planned desktop app consumes, alongside the JSON contract of
 * `unbraid plan --json`.
 */

export type {
  CommitPlan,
  PlannedCommit,
  FileChange,
  FileStatus,
  WorkingTreeState,
  GitOperation,
  RawGroup,
  LockedGroup,
} from './core/engine/types.js'

export { reconcile } from './core/engine/reconcile.js'
export { createPlan } from './core/engine/plan.js'
export type { PlanEvent, PlanDeps } from './core/engine/plan.js'
export { inferStyle, analyzeCommits } from './core/engine/style.js'
export type { RepoStyle } from './core/engine/style.js'

export { createGit } from './core/git/exec.js'
export type { Git } from './core/git/exec.js'
export { readWorkingTree } from './core/git/read.js'
export { preflight } from './core/git/preflight.js'
export { collectDiffs } from './core/git/diff.js'
export type { FileDiff } from './core/git/diff.js'
export { executePlan, push } from './core/git/write.js'
export { takeSnapshot, restoreSnapshot } from './core/git/snapshot.js'

export { loadConfig } from './core/config/load.js'
export { configSchema, defaultConfig } from './core/config/schema.js'
export type { Config } from './core/config/schema.js'

export { resolveProvider } from './core/providers/resolve.js'
export type { Provider, CompletionRequest } from './core/providers/types.js'
export { createClaudeCliProvider } from './core/providers/claude-cli.js'
export { createAnthropicProvider } from './core/providers/anthropic.js'
export { createOpenAiCompatibleProvider } from './core/providers/openai-compatible.js'

export { buildPlan } from './cli/pipeline.js'

/**
 * The review-screen reducer.
 *
 * Pure and already covered by tests, so any front end — the terminal UI, the
 * VS Code panel — can drive the same merge, reorder, rename, and remove
 * behaviour instead of reimplementing it and drifting.
 */
export { reduce, initialState } from './cli/ui/reducer.js'
export type { EditorState, EditorAction } from './cli/ui/reducer.js'
export { checkSecrets } from './cli/guard.js'
