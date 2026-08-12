<div align="center">

<img src="assets/logo.svg" alt="" width="76" height="76">

# unbraid

**Turn a messy pile of changes into clean, well-described commits — automatically.**

[![CI](https://github.com/aulianza/unbraid/actions/workflows/ci.yml/badge.svg)](https://github.com/aulianza/unbraid/actions/workflows/ci.yml)
[![Open VSX](https://img.shields.io/open-vsx/v/aulianza/unbraid-vscode?label=vs%20code&color=3178c6)](https://open-vsx.org/extension/aulianza/unbraid-vscode)
[![npm version](https://img.shields.io/npm/v/unbraid?color=cb3837&logo=npm)](https://www.npmjs.com/package/unbraid)
[![npm downloads](https://img.shields.io/npm/dm/unbraid?color=cb3837)](https://www.npmjs.com/package/unbraid)
[![node](https://img.shields.io/node/v/unbraid)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[npm](https://www.npmjs.com/package/unbraid)** · **[VS Code extension](https://open-vsx.org/extension/aulianza/unbraid-vscode)** · **[Architecture](docs/ARCHITECTURE.md)** · **[Contributing](CONTRIBUTING.md)**

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

Two ways to use it. They share the same engine, so pick whichever fits how you work.

### In your editor

**[unbraid for VS Code](https://open-vsx.org/extension/aulianza/unbraid-vscode)** — an icon in
the activity bar with your changed files, a review panel, and one-click undo. Works in VS Code,
Cursor, Windsurf, and VSCodium.

```bash
code --install-extension aulianza.unbraid-vscode
```

Or search **unbraid** in the Extensions panel.

### In your terminal

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

Otherwise, run `unbraid init` and it will walk you through the options — including running a
model **entirely on your own laptop** for free with Ollama. See [Providers](#providers).

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
unbraid init             # set up a provider, step by step
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
unbraid pr --web         # open a prefilled PR page in your browser
unbraid pr -e --web      # revise the text first, then open it
unbraid pr -t dev        # merge into dev instead of the default branch
unbraid pr -o pr.md      # save it to a file
unbraid pr --open        # create it with the GitHub CLI
```

It reads your **commits**, not the raw code, so the description reflects what you meant
rather than restating the diff.

**`--web` needs nothing installed.** It opens the same "New pull request" page you'd reach by
clicking through GitHub, with the title and description already filled in. No CLI, no token,
no login beyond the browser session you already have. You review it on GitHub and press
**Create pull request**.

If your branch hasn't been pushed, unbraid notices and offers to push it first:

```console
$ unbraid pr --web

feat/exchange-rate → master · 3 commits · 5 files

feat/exchange-rate has not been pushed yet. GitHub cannot open a pull
request for a branch it cannot see.

Push to origin/feat/exchange-rate? [Y/n]
  ✓ pushed

Opening aulianza/tripana in your browser…
```

Press Enter to accept — you already asked for a pull request, so pushing the branch is part of
what you asked for.

It also catches the quieter version of that problem — a branch that *is* pushed but has newer
local commits, which would otherwise produce a pull request silently missing your latest work.

**It describes your branch, not branches you merged in.** If you merged `dev` or another
feature branch into yours, those commits are in the diff but they aren't your work — unbraid
leaves them out of the description and notes their presence in one line instead. A branch with
two commits of its own reads as two, not sixty-four.

**Descriptions are kept short on purpose:** why the change exists, at most six one-line
bullets, and concrete testing steps. A description nobody finishes reading has failed at its
job.

**Choosing the target branch.** By default unbraid works out what you'd merge into: the
remote's default branch, falling back to `main`, `master`, `develop`, or `trunk`. Override it
per run with `-t`, or permanently:

```yaml
# .unbraidrc.yaml
pr:
  target: dev
```

**`--edit`** opens the draft in `$EDITOR` before anything is sent anywhere. First line is the
title, the rest is the description — the same convention as a git commit message. Empty the
file to cancel.

> `--web` supports GitHub. On GitLab or Bitbucket, unbraid says so instead of opening a page
> that won't work — use `-o pr.md` and paste it.

## Providers

A "provider" is whichever AI writes your commit messages. unbraid works with several.

| Provider | What you need | Cost |
| --- | --- | --- |
| **Claude Code CLI** *(default)* | Nothing — detected automatically | **Free** with your existing subscription |
| **Anthropic API** | `ANTHROPIC_API_KEY` in your environment | Pay per use |
| **Anything OpenAI-compatible** | A URL, usually a key | Varies — or free locally |

### The easy way

```bash
unbraid init
```

This walks you through picking a provider, tells you where to get a key if you need one,
writes the config file for you, and then **makes a real call to check it works** before you
walk away.

```console
$ unbraid init

unbraid setup

✓ Claude Code found — you can use it free with your existing subscription

Which AI should write your commit messages?
  ❯ 1. Claude Code — free, no API key, already installed
    2. Anthropic API
    3. Something else (OpenAI, OpenRouter, Z.AI, Groq, DeepSeek, Ollama)

Choice [1]: 1

How big should each commit be?
  ❯ 1. One commit per feature or fix
    2. One commit per file
    3. Few, large commits

Choice [1]: 1

✓ Wrote /Users/you/project/.unbraidrc.yaml

Testing the connection…
✓ claude-cli/sonnet is working

Ready. Try it out:

  cd your-project
  unbraid --dry-run
```

Add `--global` to configure every project at once instead of just this one.

### Setting it up by hand

<details>
<summary><b>Anthropic API</b></summary>

1. Get a key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Add it to your shell profile (`~/.zshrc` on macOS, `~/.bashrc` on most Linux):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

3. Open a new terminal, then create `.unbraidrc.yaml` in your project:

```yaml
provider: anthropic
providers:
  anthropic:
    model: claude-sonnet-5
```

That's it — `unbraid` will use it. Check with `unbraid config`.

</details>

<details>
<summary><b>OpenAI, OpenRouter, Z.AI, Groq, DeepSeek</b></summary>

All of these speak the same protocol, so they share one setup. Pick your service's URL:

```yaml
# .unbraidrc.yaml
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: https://api.openai.com/v1     # see the table below
    apiKeyEnv: OPENAI_API_KEY              # the env var holding your key
    model: gpt-4o
```

| Service | `baseUrl` | Get a key |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | [platform.openai.com](https://platform.openai.com/api-keys) |
| OpenRouter | `https://openrouter.ai/api/v1` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Z.AI (pay-as-you-go) | `https://api.z.ai/api/paas/v4` | [z.ai](https://z.ai/manage-apikey/apikey-list) |
| Z.AI (Coding Plan) | `https://api.z.ai/api/coding/paas/v4` | [z.ai](https://z.ai/manage-apikey/apikey-list) |
| Groq | `https://api.groq.com/openai/v1` | [console.groq.com](https://console.groq.com/keys) |
| DeepSeek | `https://api.deepseek.com/v1` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |

Then export your key:

```bash
export OPENAI_API_KEY="..."      # or OPENROUTER_API_KEY, ZAI_API_KEY, GROQ_API_KEY…
```

> **Z.AI users:** the two URLs are *not* interchangeable. A Coding Plan key sent to the
> pay-as-you-go endpoint returns a `404` that looks like an authentication error.

</details>

<details>
<summary><b>Ollama — free, and nothing leaves your laptop</b></summary>

Your code is never sent anywhere. Install [Ollama](https://ollama.com), then:

```bash
ollama pull qwen2.5-coder
ollama serve
```

```yaml
# .unbraidrc.yaml
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: http://localhost:11434/v1
    model: qwen2.5-coder
```

No API key needed. unbraid recognises local addresses and skips the credential warning,
since nothing is leaving the machine.

Quality depends on the model you run — a small local model writes vaguer messages than a
frontier one. `qwen2.5-coder` is a reasonable starting point.

</details>

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

## Staying up to date

unbraid checks npm once a day, in the background, and mentions it after a command finishes:

```
Update available  0.7.0 → 0.8.0
npm i -g unbraid@latest
```

It never delays a run — the check reads a local cache and refreshes afterwards, so a new
release is mentioned on your next run rather than blocking the current one. The command shown
matches how you installed it, whether that was npm, pnpm, or bun.

**It stays quiet when a notice would be unwelcome:** in CI, when output is piped, when you
installed via `npx` (which already fetches the newest version every time), and **when your
provider runs on your own machine** — if you chose Ollama to keep everything local, unbraid
does not make an outbound request you did not ask for.

Turn it off entirely:

```yaml
# .unbraidrc.yaml
updateCheck: false
```

or set `UNBRAID_NO_UPDATE_CHECK=1`.

The check is a plain GET for a version number. It sends no identifier, no telemetry, and
nothing about you or your code.

## Troubleshooting

**`command not found: unbraid`**
Install it with `npm install -g unbraid`, or use `npx unbraid` with no install at all.

**"No AI provider available"**
Run `unbraid init` — it walks you through the options and checks the result works.

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

## The VS Code extension

Everything below works from the command line. If you would rather stay in the editor, the
extension gives you the same thing with a panel of its own:

- Your changed files, with the icons and colours from whatever theme you already use
- Stage, unstage, discard, switch branch, and sync — without opening Source Control
- A review panel where you rename, merge, reorder, and drop commits before anything is written
- **Undo the last run**, which puts HEAD and your staging back exactly as they were
- `⌘⇧U` / `Ctrl+Shift+U` to start

[Install it from Open VSX](https://open-vsx.org/extension/aulianza/unbraid-vscode) ·
[source](extension/)

## Status

**v0.4 — early, but real.** Grouping, message generation, the review screen, commits with
automatic rollback, hunk-level splitting, PR drafting, and all three providers work and are
covered by 269 tests.

Expect rough edges. Bug reports and pull requests are genuinely welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md) if you want to
know how it works inside.

## License

[MIT](LICENSE) © [aulianza](https://aulianza.com)
