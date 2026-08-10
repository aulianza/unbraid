# Architecture

How unbraid is put together, and why. Read this before opening a PR.

## The two invariants

Everything below exists to serve these. Neither is negotiable.

**1. unbraid never modifies file contents.** It stages, commits, and — only when asked —
pushes. The working tree is read-only to this tool. This is what makes it safe to run on
uncommitted work: the worst possible failure leaves your files untouched.

**2. unbraid never loses a file.** Every changed path lands in a commit or is surfaced as
unassigned. This is enforced by code that reconciles the model's output against the real
file list, not by asking the model to be careful.

## Modules

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `core/git` | Read working tree state; stage; commit; push; snapshot and restore the index. Zero AI knowledge. | `git` binary |
| `core/providers` | One `Provider` interface: `complete(prompt, schema) → object`. Adapters for each backend. | — |
| `core/engine` | Builds prompts, runs the two passes, reconciles output into a `CommitPlan`. | `git`, `providers` |
| `cli` | Config loading, review TUI, plan execution, JSON contract. | all of the above |

The boundary that matters is `core/engine`. It is a **pure function** —
`(tree state, config) → commit plan` — with no I/O of its own. Everything interesting is
therefore testable with fixtures and a stub provider, which is why CI makes no API calls.

The contract between the engine and everything downstream is one plain-data object:

```ts
type CommitPlan = {
  version: 1
  commits: Array<{
    id: string
    title: string
    body: string | null
    files: string[]
    locked: boolean      // was pre-staged; the model never saw it
    warnings: string[]   // e.g. "also contains an unrelated rename"
  }>
  unassigned: string[]   // files the model failed to place — never dropped
}
```

Because that contract is plain JSON and reachable from the command line
(`unbraid plan --json`, `unbraid apply --plan`), any front end — the planned macOS app, an
editor extension — can drive the engine without reimplementing it.

## Run flow

```
1. SNAPSHOT   record HEAD + index → rollback point
2. READ       working tree: modified, added, deleted, renamed, and untracked-but-not-ignored
3. LOCK       anything already staged becomes a fixed group, excluded from the model
4. GROUP      pass 1: paths + diffstat + truncated hunks → grouping  (skipped under ~15 files)
5. RECONCILE  validate the model's grouping against reality
6. WRITE      pass 2: per group, in parallel, full diff → title + body
7. REVIEW     TUI: reorder, merge, split, move files, edit messages
8. EXECUTE    per commit: stage its paths, commit. Any failure → restore snapshot
9. PUSH       one push at the end, only if asked
```

### Step 5 carries the weight

Language models hallucinate file paths and silently drop files. Step 5 assumes this and
corrects for it deterministically:

- Paths not present in the working tree are discarded.
- A file assigned to several commits is kept in the first and removed from the rest.
- A file assigned to no commit lands in `unassigned` and surfaces in the TUI as an editable
  catch-all group.

This is ordinary code with ordinary tests. Prompt-level pleading ("include every file") is
not a mechanism and is not relied upon.

### Why two passes

A 100-file changeset is far too large to send as full diffs. Pass 1 sees only paths, a
diffstat, and the first few lines of each hunk — enough to decide what belongs together,
cheaply. Pass 2 then sees one group's complete diff at a time, so the message is written
with real context. Groups in pass 2 are independent and run in parallel.

Below `context.single_pass_threshold` (default 15 files) pass 1 is skipped entirely and the
whole diff goes in one call. It fits, and it's better.

## Providers

Three adapters cover nearly the whole ecosystem. All implement the same interface and must
pass the same contract test suite.

| Adapter | Auth | Notes |
| --- | --- | --- |
| `claude-cli` | None — existing Claude Code subscription | Default when the `claude` binary is present. Shells out headless. |
| `anthropic` | `ANTHROPIC_API_KEY` | Direct API. |
| `openai-compatible` | Configurable env var | Covers OpenAI, OpenRouter, Groq, DeepSeek, and Ollama via `base_url`. |

Every adapter takes a JSON Schema and returns a validated object. Parsing and retry are the
adapter's problem, never the engine's.

**Known tradeoff:** the `claude-cli` adapter is free but slower — shelling out carries a
large fixed prompt overhead and several seconds of startup per call. Parallelising pass 2
hides most of it. The API adapters are meaningfully faster; the CLI adapter is the default
because "works with zero setup and costs nothing" beats "slightly faster" for most people.

## Safety

- Refuses to run mid-rebase, mid-merge, mid-cherry-pick, or on detached HEAD without `--force`.
- Snapshots HEAD and the index before executing; any failure unwinds every created commit
  and restores original staging.
- Never pushes without explicit opt-in.
- Halts before sending credential-shaped files (`.env*`, `*.pem`, `*_rsa`) to a **remote**
  provider. Skipped for `claude-cli` and local Ollama, where nothing leaves the machine.
- Degrades rather than crashing: if grouping fails after retries, it offers a single
  all-in commit.

## Testing

| Layer | Approach |
| --- | --- |
| `core/git` | Real git repos in temp dirs — git is fast, and mocking a VCS is worse than using one |
| `core/engine` | Fixture tree states + stub provider; fully deterministic |
| Providers | Shared contract suite every adapter must pass |
| End to end | Recorded "messy tree" fixtures, asserting plan shape |

New grouping behaviour should come with a fixture. Fixtures from real repositories are the
single most valuable contribution to this project.
