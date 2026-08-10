<div align="center">

# unbraid

**Unbraid a tangled working tree into atomic commits, with AI-written messages.**

You finished the feature. Now there are 52 modified files and one bad choice to make:
spend 30 minutes staging them by hand, or throw them all into `misc: updates`.

`unbraid` reads the whole tree, works out which changes belong together, writes a real
message for each one, and shows you the plan before it touches anything.

[![npm version](https://img.shields.io/npm/v/unbraid?color=cb3837&logo=npm)](https://www.npmjs.com/package/unbraid)
[![npm downloads](https://img.shields.io/npm/dm/unbraid?color=cb3837)](https://www.npmjs.com/package/unbraid)
[![node](https://img.shields.io/node/v/unbraid)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

**[npm](https://www.npmjs.com/package/unbraid)** · **[Architecture](docs/ARCHITECTURE.md)** · **[Contributing](CONTRIBUTING.md)**

</div>

---

```console
$ unbraid

  Analyzing 52 changed files…

  ▸ 1  feat(auth): add refresh token rotation        4 files
    2  fix(api): handle null user in profile route   2 files
    3  chore(deps): bump next to 15.2                1 file
    4  refactor(ui): extract Button variants         7 files
    5  test(auth): cover expired-token path          3 files
    6  chore: update lockfile                        1 file

  [enter] edit  [space] toggle  [c] commit all  [p] push
```

One command. Six atomic commits. One push.

---

## What makes it different

Most AI commit tools write a message for the files **you have already staged** — one message,
one commit. That solves the writing. It leaves you the staging, and the staging is the part
that costs thirty minutes.

`unbraid` starts one step earlier:

- **It decides which files belong together**, not just what to call them
- **It creates several commits in one run**, so 52 files become 6 coherent commits
- **It shows you the plan first** — reorder, merge, rename, or remove before anything is written
- **It runs on a Claude Code subscription** with no API key and no per-token cost
- **It reads your repo's history**, reusing the scopes and types you already use

If you're happy staging by hand and just want a better message, a smaller tool will serve you
better. If the staging is the expensive part, that's what this is for.

## Status

**v0.1 — early, but real.** Splitting, message generation, the review screen, atomic commits
with rollback, and all three providers work and are covered by tests. Anything still unbuilt
is marked 🚧 below.

Expect rough edges at this stage. Issues and PRs welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it
fits together.

## Install

```bash
# no install
npx unbraid

# or keep it around
npm i -g unbraid
```

Requires `git` and Node 20+. Published at
[npmjs.com/package/unbraid](https://www.npmjs.com/package/unbraid).

## Quick start

```bash
cd your-messy-repo
unbraid
```

That's it. There is no config file to write, no API key to set, and no init step. If you have
[Claude Code](https://claude.com/claude-code) installed, `unbraid` finds it and uses your
existing subscription — no key, no per-token cost.

```bash
unbraid --push          # commit, then one push at the end
unbraid --dry-run       # show me the plan, change nothing
unbraid --granularity fine   # more commits, smaller scope
unbraid pr              # draft a PR title + body from this branch  🚧
```

## How it works

```
1. READ      the working tree — every changed, added, deleted, and renamed file
2. GROUP     one cheap pass over paths + diffstat decides what belongs together
3. WRITE     one pass per group, seeing that group's full diff, writes title + body
4. REVIEW    you reorder, merge, split, move files between commits, edit any message
5. COMMIT    stage each group, commit it, and optionally push once at the end
```

Two things worth knowing about how this is built:

**It never edits your files.** `unbraid` only stages, commits, and — if you ask — pushes.
Your working tree is read-only to this tool. If anything fails mid-run, every commit it made
is unwound and your original staging is restored. You end up exactly where you started.

**It never loses a file.** The model's grouping is reconciled against the real file list in
code, not by asking the model nicely. Hallucinated paths are dropped, duplicates are
de-duplicated, and any file the model failed to place is surfaced to you as an editable
catch-all group. Every changed path is accounted for, every run.

## Providers

`unbraid` talks to whatever you already have. Three adapters cover nearly everything:

| Provider | Setup | Cost |
| --- | --- | --- |
| **Claude Code CLI** *(default)* | Nothing — detected automatically | Covered by your existing subscription |
| **Anthropic API** | `ANTHROPIC_API_KEY` | Per token |
| **OpenAI-compatible** | `baseUrl` + key | Per token, or free locally |

That last row is the useful one: a single adapter covers OpenAI, OpenRouter, Groq, DeepSeek,
and **Ollama**, so you can run this fully offline against a local model if you'd rather no
diff ever leaves your machine.

```yaml
# .unbraidrc.yaml
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: http://localhost:11434/v1   # ollama — nothing leaves your laptop
    model: qwen2.5-coder
```

## Configuration

`unbraid` is designed to be correct with no configuration and adjustable in every dimension
when you want it. **Every value below is the default** — deleting the file changes nothing.

```yaml
# .unbraidrc.yaml

provider: auto              # auto | claude-cli | anthropic | openai-compatible
model: auto

grouping:
  granularity: semantic     # fine | semantic | coarse
  maxCommits: 20
  respectStaged: true      # already staged something? that stays exactly as you left it
  hints:                    # your rules, applied before the AI sees anything
    - match: "(package-lock.json|pnpm-lock.yaml|bun.lock)"
      group: "chore(deps): update lockfile"
    - match: "^docs/"
      group: "docs"

message:
  format: conventional      # conventional | gitmoji | plain | auto
  types: [feat, fix, refactor, chore, docs, test, style, perf, build, ci]
  scope: auto               # auto | off | required
  maxTitleLength: 72
  body: auto                # always | never | auto
  bodyStyle: bullets       # bullets | prose
  language: en              # write commit messages in any language
  ticketPattern: null      # "([A-Z]+-\\d+)" — lifts the JIRA key from your branch name
  signOff: false

context:
  singlePassThreshold: 15
  truncateLines: 20
  maxDiffBytes: 100000
  logSample: 20            # how many past commits to read for style
  exclude: ["*.lock", "*.min.js", "*.snap", "dist/**", "*.{png,jpg,svg,woff2}"]

execute:
  push: false
  pushRemote: origin
  autoconfirm: false        # skip the review screen — for CI and scripts
  onError: rollback        # rollback | keep
```

Config resolves in layers, later winning:
**defaults → `~/.config/unbraid/config.yaml` → `.unbraidrc.yaml` → env vars → CLI flags.**
Run `unbraid config` to print the resolved values and where each one came from.

### Message format

The default is **Conventional Commits** — `type(scope): subject` — because a parseable,
consistent history is worth more than blending into an inconsistent one:

```
feat(auth): add refresh token rotation
fix(api): handle null user in profile route
refactor: migrate from pages router to app router
chore(deps): bump next to 15.2
```

Scopes are *encouraged, not mandated*. `unbraid` uses one when a real area exists — a package,
module, route, or feature — and omits it otherwise. Forcing a scope on every commit is how you
end up with `fix(fix):`, which is worse than no scope at all. Set `scope: required` if you
disagree, or `scope: off` to drop them entirely.

`unbraid` also reads the last 20 commits in your repo to pick up the scopes and types you
already use, so it reuses `ui` and `i18n` rather than inventing `frontend` and `translations`.

Prefer to blend in instead — contributing to someone else's project, say? Set
`format: auto` and it matches whatever the repository already does, gitmoji and plain prose
included.

## Scripting

Every part of `unbraid` is available headlessly, so you can wire it into anything:

```bash
unbraid plan --json > plan.json     # analyze only, no side effects
$EDITOR plan.json
unbraid apply --plan plan.json      # execute a plan you've edited
```

This is also the seam the desktop app is built on — see below.

## Roadmap

- [x] **v1 — the CLI.** File-level grouping, AI messages, review TUI, atomic commits, push.
- [ ] **`unbraid pr`.** Draft a PR title and body from the branch's commits.
- [ ] **v2 — macOS app.** A native SwiftUI shell over the same engine, driving it through
      `plan --json`. The point is visual diff review: seeing the actual hunks while you drag
      files between commits. Not a rewrite — the grouping logic stays in one place.
- [ ] **v2 — hunk-level splitting.** When one file mixes a bug fix and an unrelated rename,
      split the file across commits instead of just flagging it.
- [ ] VS Code extension, `prepare-commit-msg` hook mode, and splitting commits you already made.

## Contributing

Contributions are very welcome, especially provider adapters and "messy tree" test fixtures
from real repos. See [CONTRIBUTING.md](CONTRIBUTING.md).

The engine is a pure function — `(tree state, config) → commit plan` — so most logic can be
tested with fixtures and a stub provider. **CI makes no API calls.**

## License

[MIT](LICENSE) © [aulianza](https://aulianza.com)
