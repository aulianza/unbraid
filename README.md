<div align="center">

# unbraid

**Turn a messy pile of changes into clean, well-described commits — automatically.**

[![CI](https://github.com/aulianza/unbraid/actions/workflows/ci.yml/badge.svg)](https://github.com/aulianza/unbraid/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/unbraid?color=cb3837&logo=npm)](https://www.npmjs.com/package/unbraid)
[![npm downloads](https://img.shields.io/npm/dm/unbraid?color=cb3837)](https://www.npmjs.com/package/unbraid)
[![node](https://img.shields.io/node/v/unbraid)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[npm](https://www.npmjs.com/package/unbraid)** · **[Architecture](docs/ARCHITECTURE.md)** · **[Contributing](CONTRIBUTING.md)**

</div>

---

## The problem

You've been coding for a few hours. You fixed a bug, added a feature, tweaked some styling,
and updated a dependency. Now `git status` shows **52 changed files** and you have two bad
options.

**Option A — commit it all at once.** Fast, and you end up with:

```
* 4f2a1c9  update stuff
```

Six months later you need to undo just the styling change. You can't, because it's welded to
the bug fix and the feature.

**Option B — sort it out by hand.** Add the auth files, write a message, commit. Add the API
files, write a message, commit. Repeat eight times. Good history, **thirty minutes**. So most
days you do Option A instead.

`unbraid` is a third option.

## What it does

Run one command. It reads all your changes, works out which ones belong together, writes a
proper message for each group, and shows you the plan before touching anything.

```console
$ unbraid

52 changed · conventional style · claude-cli/sonnet
⠹ Grouping 52 files 8s

  ▸ 1  feat(auth): add refresh token rotation        4 files
    2  fix(api): handle null user in profile route   2 files
    3  chore(deps): bump next to 15.2                1 file
    4  refactor(ui): extract Button variants         7 files
    5  test(auth): cover expired-token path          3 files
    6  chore: update lockfile                        1 file

  ↑↓ move · space files · e edit · m merge · d remove · c commit · q quit
```

Press `c` and you get six commits instead of one. The whole thing takes about a minute.

> **New to some of these words?** *Staging*, *hunk*, *conventional commits* — there's a
> plain-English [glossary](#glossary) at the bottom. You don't need to read it first.

## Install

You need [Node.js](https://nodejs.org) 20 or newer, and git.

```bash
# Try it without installing anything
npx unbraid --dry-run

# Or install it properly
npm install -g unbraid
```

`--dry-run` means "show me what you'd do, but don't actually do it." A safe first step.

## Your first run

```bash
cd ~/your-project     # any project with uncommitted changes
unbraid --dry-run
```

You'll see the plan, and nothing else happens. When you're ready for real:

```bash
unbraid
```

**Nervous? Do it on a branch you can throw away:**

```bash
git checkout -b unbraid-test
unbraid
```

If you don't like the result, undo all of it:

```bash
git reset --hard origin/main
```

## Is this safe?

Short answer: yes, and the tool is built around that question. Two guarantees:

**1. It never changes your files.** unbraid only *stages* and *commits*. It never edits,
deletes, or overwrites anything in your project — the code on your disk is read-only to this
tool. If something fails halfway through, every commit it made is undone and your setup is
put back exactly as it was.

**2. It never loses a change.** AI models make mistakes: they invent filenames, list the same
file twice, or quietly forget one. So unbraid doesn't trust the AI's answer. It checks every
file the AI mentioned against your real files — invented names are dropped, duplicates
removed, and anything the AI forgot is shown to you instead of being skipped.

Every changed file is accounted for on every run. That's enforced by code and covered by
tests, not by asking the AI nicely.

## Does it cost money?

**If you have [Claude Code](https://claude.com/claude-code) installed and signed in: no.**
unbraid finds it automatically and uses the subscription you already pay for. No API key, no
per-use charge, no setup.

Otherwise there are options — see [Providers](#providers), including running a model
**entirely on your own laptop** for free with Ollama.

## Using the review screen

After unbraid thinks (10–60 seconds, depending), you get an interactive list. **Nothing is
committed until you press `c`.**

| Key | What it does |
| --- | --- |
| `↑` `↓` | Move between commits |
| `space` | Show which files are in this commit |
| `e` | Rename this commit's message |
| `J` `K` | Move this commit up or down |
| `m` | Merge this commit into the one above it |
| `d` | Remove this commit (the files aren't deleted — they go back to the pile) |
| `c` | **Commit everything** |
| `q` | Quit without committing anything |

## Everyday commands

```bash
unbraid                  # the normal thing: plan, review, commit
unbraid --dry-run        # show the plan, change nothing
unbraid --push           # commit, then push once at the end
unbraid -g fine          # smaller commits — roughly one per file
unbraid -g coarse        # fewer, bigger commits
unbraid --hunks          # split one file across commits (see below)
unbraid pr               # write a pull request description
unbraid config           # show your current settings
unbraid --help           # everything
```

### How big should commits be?

That's the `-g` (granularity) setting. The same 30 changed files, three different results:

| Setting | Result | Good for |
| --- | --- | --- |
| `-g coarse` | ~3 commits | Grouping broadly: features, fixes, chores |
| *(default)* | ~6 commits | One commit per feature or fix |
| `-g fine` | ~12 commits | Roughly one commit per file |

If you always want one of these, put it in a config file rather than typing it every time —
see [Configuration](#configuration).

### Splitting one file across commits

Normally a commit takes whole files. So if you fixed a bug on line 3 **and** renamed a
function on line 40 of the same file, they're stuck in one commit together.

`--hunks` unsticks them. (A *hunk* is git's word for one group of changed lines.)

```bash
unbraid --hunks
```

```
1. fix(api): guard getUser against missing records
     · src/user.ts (1 of its changes)

2. refactor(api): rename deleteUser to removeUser
     · src/user.ts (1 of its changes)
```

Two commits from one file. Now you could undo the rename without undoing the bug fix.

It's **off by default**, because most of the time a file's changes do belong together.

<details>
<summary><b>How this stays safe</b></summary>

The obvious approach is `git apply`, peeling off one group of changes at a time. That's
fragile: removing one group shifts the line numbers of every group after it, so patches
either fail or — much worse — apply in the wrong place.

unbraid doesn't do that. It calculates exactly what the file should contain at each commit
and writes that content straight into git's internal storage. Your actual file is never
touched.

Before it will split a file at all, it checks that applying *all* of that file's changes
reproduces your file byte-for-byte. If that check fails, unbraid decides it doesn't
understand the file well enough to take it apart, and commits it whole instead.

</details>

### Writing a pull request

Once your commits exist, unbraid can describe the whole branch:

```bash
unbraid pr               # print a title and description
unbraid pr -o pr.md      # save it to a file
unbraid pr --open        # create the PR (needs the GitHub CLI)
```

It reads your **commits**, not the raw code, so the description reflects what you meant
rather than restating the diff.

## Providers

A "provider" is whichever AI writes your commit messages. unbraid works with several.

| Provider | What you need | Cost |
| --- | --- | --- |
| **Claude Code CLI** *(default)* | Nothing — detected automatically | **Free** with your existing subscription |
| **Anthropic API** | `ANTHROPIC_API_KEY` in your environment | Pay per use |
| **Anything OpenAI-compatible** | A URL, usually a key | Varies — or free locally |

That last row covers OpenAI, OpenRouter, Groq, DeepSeek, and **Ollama**. Ollama runs a model
on your own computer, so your code never leaves your laptop:

```yaml
# .unbraidrc.yaml
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: http://localhost:11434/v1
    model: qwen2.5-coder
```

**A note on speed.** The free Claude Code option is slower — roughly 10–60 seconds per run,
because it starts a whole CLI each time. An API key is noticeably faster. Free-and-slower is
the right default for most people, but that's the trade.

## Configuration

**You don't need any of this.** unbraid is built to be correct out of the box. Configure it
only when you want something different.

Create `.unbraidrc.yaml` in your project (settings for that project), or
`~/.config/unbraid/config.yaml` (settings for everything you do).

The most common thing people want:

```yaml
# Always make small, per-file commits
grouping:
  granularity: fine
```

<details>
<summary><b>Every available setting</b></summary>

Every value shown is the default. Deleting the file changes nothing.

```yaml
provider: auto              # auto | claude-cli | anthropic | openai-compatible
model: auto

grouping:
  granularity: semantic     # fine | semantic | coarse
  maxCommits: 20            # never make more commits than this
  respectStaged: true       # already staged something? it's left exactly as you set it
  hunks: false              # allow one file to be split across commits
  expandUntrackedDirsUpTo: 10   # a new folder with more files than this counts as one item
  hints:                    # your own rules, applied before the AI sees anything
    - match: "(package-lock.json|pnpm-lock.yaml|bun.lock)"
      group: "chore(deps): update lockfile"

message:
  format: conventional      # conventional | gitmoji | plain | auto
  types: [feat, fix, refactor, chore, docs, test, style, perf, build, ci]
  scope: auto               # auto | off | required
  maxTitleLength: 72
  body: auto                # always | never | auto
  bodyStyle: bullets        # bullets | prose
  language: en              # write commit messages in any language
  ticketPattern: null       # "([A-Z]+-\\d+)" pulls a ticket number from your branch name
  signOff: false

context:
  singlePassThreshold: 15   # below this many files, use one faster AI call
  truncateLines: 20         # how much of each file the AI sees when grouping
  maxDiffBytes: 100000
  logSample: 20             # how many past commits to read to learn your style
  exclude: ["*.lock", "*.min.js", "*.snap", "dist/**", "*.{png,jpg,svg,woff2}"]

execute:
  push: false
  pushRemote: origin
  autoconfirm: false        # skip the review screen — for scripts
  onError: rollback         # rollback | keep
  verify: true              # run your git hooks

guard:
  secrets: true             # stop before sending credential-like files to a cloud provider
  secretPatterns: [".env", ".env.*", "*.pem", "*_rsa", "*.key", "*.p12"]
```

Settings combine in layers, later ones winning:
**defaults → `~/.config/unbraid/config.yaml` → `.unbraidrc.yaml` → environment → command-line flags**

Run `unbraid config` to see the result and where each value came from.

Note that `exclude` means "don't spend AI tokens reading this file." Those files are **still
committed** — they're just not sent to the AI.

</details>

### Message style

By default unbraid writes [Conventional Commits](#glossary) — `type(scope): summary`:

```
feat(auth): add refresh token rotation
fix(api): handle null user in profile route
refactor: migrate from pages router to app router
```

It also reads your last 20 commits to pick up the scopes you already use, so it writes `ui`
and `i18n` rather than inventing `frontend` and `translations`.

Want it to match your existing style instead — even if that's plain sentences or emoji? Set
`message.format: auto`.

## Scripting

Every part of unbraid works without the interactive screen, so you can automate it:

```bash
unbraid plan -o plan.json     # work out the commits, change nothing
$EDITOR plan.json             # edit by hand if you like
unbraid apply --plan plan.json
```

## Troubleshooting

**`command not found: unbraid`**
Install it with `npm install -g unbraid`, or use `npx unbraid` with no install at all.

**"No AI provider available"**
Install [Claude Code](https://claude.com/claude-code) and sign in (free with a subscription),
or set `ANTHROPIC_API_KEY`, or configure a local model. unbraid prints the options.

**"Nothing to commit — the working tree is clean"**
You have no uncommitted changes. Edit something first.

**"A merge is in progress"**
Finish or abort your merge or rebase first. unbraid won't commit into a half-finished
operation, because it couldn't safely undo one.

**It's slow.**
Expected on the free Claude Code provider — it restarts a CLI on every call. An API key is
faster. Watch the timer; it's working.

**It grouped things wrongly.**
Press `e` to rename, `m` to merge commits together, `J`/`K` to reorder, or `q` to throw the
whole plan away. Nothing is committed until you press `c`.

## Glossary

**Staging** — Git's waiting room. Before committing you tell git which changes to include
(`git add`). Deciding what goes in each batch is the tedious part unbraid automates.

**Atomic commit** — A commit that does exactly one thing. Easier to review, easier to undo,
and it makes your history readable.

**Hunk** — One group of changed lines within a file. Change the top and the bottom of a file
and you have two hunks. Usually they're related; when they're not, `--hunks` can put them in
separate commits.

**Conventional Commits** — A widely used format: `type(scope): summary`, like
`fix(auth): reject expired tokens`. Machines can parse it to build changelogs, and humans can
scan it quickly.

**Working tree** — Your project files as they exist on disk right now.

## Status

**v0.4 — early, but real.** Grouping, message generation, the review screen, commits with
automatic rollback, hunk-level splitting, PR drafting, and all three providers work and are
covered by 269 tests.

Expect rough edges. Bug reports and pull requests are genuinely welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md) if you want to
know how it works inside.

## License

[MIT](LICENSE) © [aulianza](https://aulianza.com)
