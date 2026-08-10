<div align="center">

# unbraid

**Unbraid a tangled working tree into atomic commits, with AI-written messages.**

You finished the feature. Now there are 52 modified files and one bad choice to make:
spend 30 minutes staging them by hand, or throw them all into `misc: updates`.

`unbraid` reads the whole tree, works out which changes belong together, writes a real
message for each one, and shows you the plan before it touches anything.

[![Status](https://img.shields.io/badge/status-pre--alpha-orange)](#status)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

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

## Why not `aicommits` or `OpenCommit`?

Those tools are good, and they solve a different half of the problem. Both write a message
for files **you have already staged** — one message, one commit. The staging is still on you,
and the staging is the part that takes thirty minutes.

`unbraid` starts one step earlier.

|  | aicommits / OpenCommit | unbraid |
| --- | :---: | :---: |
| Writes the commit message | ✅ | ✅ |
| **Decides which files belong together** | ❌ | ✅ |
| **Creates multiple commits in one run** | ❌ | ✅ |
| Matches your repo's existing message style | ❌ | ✅ |
| Works with a Claude subscription, no API key | ❌ | ✅ |
| Review and edit the plan before it commits | ❌ | ✅ |

If you already stage by hand and just want a better message, use theirs — it's a smaller tool
for a smaller job. If the staging is what's costing you, that's this.

## Status

**Pre-alpha. Not yet published to npm.** The design is settled — see
[ARCHITECTURE.md](docs/ARCHITECTURE.md) — and implementation is in progress. Star the repo
if you want to hear when it's usable, or read [CONTRIBUTING.md](CONTRIBUTING.md) if you'd
like to help build it.

This README describes v1 as designed. Anything not yet working is marked 🚧.

## Install

```bash
# no install
npx unbraid

# or keep it around
npm i -g unbraid
```

Requires `git` and Node 20+.

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
| **OpenAI-compatible** | `base_url` + key | Per token, or free locally |

That last row is the useful one: a single adapter covers OpenAI, OpenRouter, Groq, DeepSeek,
and **Ollama**, so you can run this fully offline against a local model if you'd rather no
diff ever leaves your machine.

```yaml
# .unbraidrc.yaml
provider: openai-compatible
providers:
  openai-compatible:
    base_url: http://localhost:11434/v1   # ollama — nothing leaves your laptop
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
  max_commits: 20
  respect_staged: true      # already staged something? that stays exactly as you left it
  hints:                    # your rules, applied before the AI sees anything
    - match: "(package-lock.json|pnpm-lock.yaml|bun.lock)"
      group: "chore(deps): update lockfile"
    - match: "^docs/"
      group: "docs"

message:
  format: conventional      # conventional | gitmoji | plain | auto
  types: [feat, fix, refactor, chore, docs, test, style, perf, build, ci]
  scope: auto               # auto | off | required
  max_title_length: 72
  body: auto                # always | never | auto
  body_style: bullets       # bullets | prose
  language: en              # write commit messages in any language
  ticket_pattern: null      # "([A-Z]+-\\d+)" — lifts the JIRA key from your branch name
  sign_off: false

context:
  single_pass_threshold: 15
  truncate_lines: 20
  max_diff_bytes: 100000
  log_sample: 20            # how many past commits to read for style
  exclude: ["*.lock", "*.min.js", "*.snap", "dist/**", "*.{png,jpg,svg,woff2}"]

execute:
  push: false
  push_remote: origin
  autoconfirm: false        # skip the review screen — for CI and scripts
  on_error: rollback        # rollback | keep
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
unbraid plan --json > plan.json     # analyze only, no side effects  🚧
$EDITOR plan.json
unbraid apply --plan plan.json      # execute a plan you've edited   🚧
```

This is also the seam the desktop app is built on — see below.

## Roadmap

- [ ] **v1 — the CLI.** File-level grouping, AI messages, review TUI, push, `unbraid pr`.
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
