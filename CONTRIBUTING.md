# Contributing to unbraid

Thanks for looking. unbraid is pre-alpha — the design is settled, the implementation is
underway, and help is genuinely useful right now.

Start with [ARCHITECTURE.md](docs/ARCHITECTURE.md). It explains the module boundaries, the
run flow, and the constraints. Most review comments are answered there.

## The two invariants

Any change must preserve both. They are the reason the tool is safe to run on a real repo.

1. **unbraid never modifies file contents.** It stages, commits, and — only when asked —
   pushes. The working tree is read-only to this tool.
2. **unbraid never loses a file.** Every changed path lands in a commit or in `unassigned`.
   This is enforced in code that reconciles the model's output against the real file list,
   not by prompt instructions.

If a PR needs to weaken either one, open an issue first so we can talk about it.

## Where help is most useful

- **Provider adapters.** Every adapter implements one interface and must pass the shared
  contract suite. Adding one should be a small, self-contained PR.
- **"Messy tree" fixtures.** Recorded working-tree states from real repos, used to test
  grouping quality. These are the highest-value contribution and need no TypeScript.
- **Grouping quality.** Prompt and heuristic improvements, measured against the fixtures.

## Development

```bash
git clone https://github.com/aulianza/unbraid
cd unbraid
npm install
npm test
```

**CI makes no API calls.** The engine is a pure function — `(tree state, config) → commit
plan` — tested with fixtures and a stub provider. If your change requires a live model to
test, that's a signal the logic belongs in the engine rather than the prompt.

## Pull requests

- One concern per PR.
- Add or update a test. For grouping changes, add a fixture.
- Run `npm test` before pushing.

## Code of conduct

Be decent to each other. Harassment or hostility gets you removed from the project.
