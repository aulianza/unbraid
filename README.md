<div align="center">

<img src="assets/logo.svg" alt="" width="76" height="76">

# unbraid

### Turn a messy pile of changes into clean, well-described commits.

[![CI](https://github.com/aulianza/unbraid/actions/workflows/ci.yml/badge.svg)](https://github.com/aulianza/unbraid/actions/workflows/ci.yml)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/aulianza.unbraid-vscode?label=vs%20code&color=3178c6)](https://marketplace.visualstudio.com/items?itemName=aulianza.unbraid-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/aulianza/unbraid-vscode?label=open%20vsx&color=a60ee5)](https://open-vsx.org/extension/aulianza/unbraid-vscode)
[![npm](https://img.shields.io/npm/v/unbraid?color=cb3837&logo=npm)](https://www.npmjs.com/package/unbraid)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[Install](#install)** · **[How it works](#how-it-works)** · **[Providers](#providers)** · **[Configuration](#configuration)** · **[VS Code](#in-your-editor)**

</div>

---

## The problem

You've been in the zone for three hours. Auth got fixed, a feature landed, some styling
changed, a dependency moved. It all works.

Then `git status` prints 52 files and the momentum dies. Sorting that pile into commits that
say something takes half an hour of `git add` and message-writing — so you do the honest thing:

```
* 4f2a1c9  update stuff
```

The work was good. The record of it is useless — to your reviewer, to your teammate, and to
you next month.

**unbraid does the sorting.** It reads every change, works out what belongs with what, writes
a real message for each group, and shows you the plan before touching anything.

## What it does

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

One command, about a minute, six commits a reviewer can actually read.

> **New to some of these words?** *Staging*, *hunk*, *conventional commits* — there's a
> plain-English [glossary](#glossary) at the bottom. You don't need it to start.

---

## Install

### In your editor

**[unbraid for VS Code](https://marketplace.visualstudio.com/items?itemName=aulianza.unbraid-vscode)**
— your changed files, a review panel, and one-click undo, in a panel of its own.

```bash
code --install-extension aulianza.unbraid-vscode
```

Or search **unbraid** in the Extensions panel. Works in VS Code, Cursor, Windsurf, VSCodium,
and Gitpod.

### In your terminal

Needs [Node.js](https://nodejs.org) 20+ and git.

```bash
npx unbraid --dry-run     # try it — changes nothing
npm install -g unbraid    # or keep it around
```

---

## Your first run

```bash
cd ~/your-project
unbraid --dry-run
```

You'll see the plan, and nothing else happens. When you're ready:

```bash
unbraid
```

**Want a safety net?** Do it on a branch you can throw away:

```bash
git checkout -b unbraid-test
unbraid
# don't like it?
git reset --hard origin/main
```

## Is this safe?

Two guarantees, both enforced in code and covered by tests.

**It never changes your files.** unbraid only *stages* and *commits*. It never edits, deletes,
or overwrites anything in your project — your code is read-only to this tool. If something
fails halfway through, every commit it made is undone and your staging restored exactly.

**It never loses a change.** AI models invent filenames, list the same file twice, and forget
others. So unbraid doesn't trust the answer: it checks every file the model named against your
real changes. Invented ones are dropped, duplicates removed, anything forgotten is shown to
you rather than skipped.

## Does it cost money?

**Not if you already have [Claude Code](https://claude.com/claude-code) or the
[Codex CLI](https://developers.openai.com/codex/cli).** unbraid finds either and uses the
subscription you already pay for — no API key, no per-use charge, no setup.

Otherwise run `unbraid init`, which walks you through the alternatives — including running a
model **entirely on your own machine** for free. See [Providers](#providers).

---

## How it works

```
1. READ     every changed, added, deleted, renamed, and untracked file
2. GROUP    a cheap pass over paths and truncated diffs decides what belongs together
3. WRITE    one pass per group, over that group's full diff, writes title and body
4. REVIEW   you reorder, merge, rename, or drop anything before it's written
5. COMMIT   stage each group, commit it, optionally push once at the end
```

Under ~15 files it does steps 2 and 3 in one pass, which is both faster and better.

### The review screen

Nothing is committed until you press `c`.

| Key | |
| --- | --- |
| `↑` `↓` | move between commits |
| `space` | show this commit's files |
| `e` | rename it |
| `J` `K` | move it up or down |
| `m` | merge into the commit above |
| `d` | remove it — files go back to the pile, never deleted |
| `c` | **commit everything** |
| `q` | quit, committing nothing |

---

## Everyday commands

```bash
unbraid init             # set up a provider, step by step
unbraid                  # plan, review, commit
unbraid --dry-run        # show the plan, change nothing
unbraid --push           # commit, then push once
unbraid -g fine          # smaller commits, roughly one per file
unbraid --hunks          # split a file that mixes two concerns
unbraid pr               # open a pull request for this branch
unbraid config           # show settings and where each came from
unbraid -v               # which version you have
unbraid --help           # everything
```

### How big should commits be?

The `-g` setting. Same 30 files, three results:

| | Commits | Good for |
| --- | --- | --- |
| `-g coarse` | ~3 | broad strokes: features, fixes, chores |
| *(default)* | ~6 | one per feature or fix |
| `-g fine` | ~12 | roughly one per file |

Want it every time? Put it in a [config file](#configuration) rather than typing it.

### Splitting one file across commits

A commit normally takes whole files. So a bug fix on line 3 and an unrelated rename on line 40
end up stuck together.

```bash
unbraid --hunks
```

```
1. fix(api): guard getUser against missing records
     · src/user.ts (1 of its changes)

2. refactor(api): rename deleteUser to removeUser
     · src/user.ts (1 of its changes)
```

Two commits from one file. Off by default — most files don't mix concerns.

<details>
<summary><b>How this stays safe</b></summary>

The obvious approach is `git apply`, peeling off one group at a time. That's fragile: removing
one group shifts the line numbers of every group after it, so patches fail or — worse — apply
in the wrong place.

unbraid doesn't do that. It computes exactly what the file should contain at each commit and
writes that content straight into git's object store. Your file is never touched.

And before it will split a file at all, it checks that applying *all* of that file's changes
reproduces your file byte-for-byte. If that check fails, it commits the file whole instead.

</details>

### Opening a pull request

Commit on a branch and unbraid asks the obvious next question — after telling you exactly what
it's about to do:

```
6 commits created.

  Branch      fix/public-web-audit
  Repository  acme/storefront on github.com
  Pushing     origin/fix/public-web-audit — a new branch on the remote
  Opens       a pull request into master

Open this pull request? [Y/n]
```

Say yes and it writes the title and description, pushes, and opens the page. No second command,
no re-typing the base branch.

**If a pull request is already open for the branch**, there's nothing to create — the commits
just need to get there. So it offers that instead:

```
  Branch      fix/public-web-audit
  Repository  acme/storefront on github.com
  Pushing     3 commits to origin/fix/public-web-audit
  Updates     pull request #42
              https://github.com/acme/storefront/pull/42

Push to origin/fix/public-web-audit? [Y/n]
```

No model call, no draft — just the one step left. And if that pull request already has every
commit, unbraid says so and asks nothing.

The check runs while your commits are being written, so it costs you nothing: by the time the
last commit lands, the question is already on screen.

It only asks when the answer could be yes — you're on a branch, not on `main`, and the remote is
GitHub. Turn the question off for good with `pr.offerAfterCommit: false`.

**It pushes the branch you are on, to the branch of the same name.** If yours tracks something
else — created from `dev` with `--track`, say — the summary names the ref the push writes to and
says so explicitly, because the branch it tracks is not the one being written:

```
  Pushing     origin/games/word-scramble — a new branch on the remote
              (this branch tracks origin/dev, which is not affected)
```

Or run it yourself, any time:

```bash
unbraid pr               # write it and open the PR page
unbraid pr --draft       # just print the title and description
unbraid pr -e            # edit it first, then open
unbraid pr -t dev        # target a different branch
unbraid pr --open        # create it with the GitHub CLI instead
unbraid pr -o pr.md      # save it to a file
```

The default needs nothing installed — it opens GitHub's own "New pull request" page with the
fields filled in, using the browser session you already have. If your branch isn't pushed,
unbraid offers to push it first, and it catches the quieter case too: a branch that *is* pushed
but has newer local commits, which would otherwise produce a PR missing your latest work.

It describes **your** branch, not branches you merged in. Merge `dev` into yours and those
commits stay out of the description — a branch with two commits of its own reads as two, not
sixty-four.

---

## Providers

A "provider" is whichever AI writes your messages. Two of them cost nothing extra.

| Provider | What you need | Cost |
| --- | --- | --- |
| **Claude Code** *(default)* | nothing — detected automatically | **free** with your subscription |
| **Codex CLI** | nothing — detected automatically | **free** with your subscription |
| **Anthropic API** | an API key | per token |
| **Anything OpenAI-compatible** | a URL, usually a key | varies, or free locally |
| **Anything Anthropic-compatible** | a URL, usually a key | varies, or free locally |

With `provider: auto`, unbraid prefers the CLIs — they cost nothing beyond what you already
pay for — then falls back to whichever API key it finds.

### The easy way

```bash
unbraid init
```

Walks you through the options, takes your API key if one is needed, writes the config, and then
**makes a real call to check it works** before you walk away.

```console
$ unbraid init

✓ Claude Code found — free with your existing subscription

Which AI should write your commit messages?
  ❯ 1. Claude Code — free, no API key, already installed
    2. Codex CLI — free, no API key
    3. Anthropic API
    4. Something else (OpenAI, OpenRouter, Z.AI, Groq, DeepSeek, Ollama, your own endpoint)

  ↑↓ move · 1-9 pick · enter confirm

✓ Wrote .unbraidrc.yaml

⠹ Testing the connection 2s
✓ claude-cli/sonnet is working
```

Keys you paste are stored in `~/.config/unbraid/credentials.json`, readable only by you —
**never** in your repository's config, which is a file you commit. An exported environment
variable always wins over a stored key.

Add `--global` to configure every project at once.

### Setting it up by hand

<details>
<summary><b>Claude Code or Codex CLI</b> — free with a subscription</summary>

Install either and sign in. unbraid finds it with no configuration:

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://developers.openai.com/codex/cli)

To pin one explicitly:

```yaml
# .unbraidrc.yaml
provider: codex-cli      # or claude-cli
```

Both run headless, sandboxed read-only, and are asked for schema-conforming JSON — unbraid
never lets an agent CLI execute anything on your behalf.

> **Codex users:** if you run codex behind a custom `--profile`, check that the profile still
> honours `--output-schema`. Some routing profiles return plain text instead, and unbraid then
> falls back to a single commit.

</details>

<details>
<summary><b>Anthropic API</b></summary>

Get a key from [console.anthropic.com](https://console.anthropic.com/settings/keys), then run
`unbraid init` and paste it — or export it yourself:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

```yaml
# .unbraidrc.yaml
provider: anthropic
providers:
  anthropic:
    model: claude-sonnet-5
```

</details>

<details>
<summary><b>OpenAI, OpenRouter, Z.AI, Groq, DeepSeek</b></summary>

All speak the same protocol, so they share one setup:

```yaml
# .unbraidrc.yaml
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
    model: gpt-4o
```

| Service | `baseUrl` | Key |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | [platform.openai.com](https://platform.openai.com/api-keys) |
| OpenRouter | `https://openrouter.ai/api/v1` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Z.AI — pay as you go | `https://api.z.ai/api/paas/v4` | [z.ai](https://z.ai/manage-apikey/apikey-list) |
| Z.AI — Coding Plan | `https://api.z.ai/api/coding/paas/v4` | [z.ai](https://z.ai/manage-apikey/apikey-list) |
| Groq | `https://api.groq.com/openai/v1` | [console.groq.com](https://console.groq.com/keys) |
| DeepSeek | `https://api.deepseek.com/v1` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |

> **Z.AI:** the two URLs are not interchangeable. A Coding Plan key sent to the pay-as-you-go
> endpoint returns a `404` that looks like an authentication error.

</details>

<details>
<summary><b>Ollama</b> — free, and nothing leaves your machine</summary>

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

No key needed. unbraid recognises local addresses, skips the credential warning, and never
checks for updates — nothing leaves the machine.

Quality tracks the model: a small local one writes vaguer messages than a frontier one.

</details>

<details>
<summary><b>Your own endpoint</b> — a gateway, a proxy, anything with a URL</summary>

Running through OneRouter, LiteLLM, vLLM, LM Studio, an internal proxy, or anything else with a
URL? The last two entries in `unbraid init` ask for three things — the endpoint, the model, and
the key — instead of trying to guess them:

```
    8. Any OpenAI-compatible endpoint — enter your own URL
    9. Any Anthropic-compatible endpoint — enter your own URL
```

Pick by the API the endpoint speaks, not by whose model is behind it. A gateway serving Claude
over an OpenAI-shaped API is option 8.

```yaml
# .unbraidrc.yaml — OpenAI-shaped
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: https://your-gateway.example.com/v1
    apiKeyEnv: UNBRAID_API_KEY
    model: whatever-your-gateway-calls-it
```

```yaml
# .unbraidrc.yaml — Anthropic-shaped
provider: anthropic
providers:
  anthropic:
    baseUrl: https://your-gateway.example.com
    apiKeyEnv: UNBRAID_API_KEY
    model: whatever-your-gateway-calls-it
```

**The two base URLs stop in different places.** unbraid appends `/chat/completions` to the first
and `/v1/messages` to the second, so the OpenAI form ends at `/v1` and the Anthropic form ends at
the host. Paste a whole endpoint into either and the wizard trims it for you.

unbraid asks for "your gw.example.com API key" — it is your provider's key, and it is stored
under the name `UNBRAID_API_KEY` rather than `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, because a
gateway key is neither of those and filing it under their name would shadow a real one. Prefer
your own variable? Set `apiKeyEnv` to anything you like and export that instead.

</details>

**A note on speed.** The free CLI providers are slower — 10–60 seconds a run, since each starts
a whole CLI. An API key is noticeably faster. Free-and-slower is the right default for most
people, but that's the trade.

---

## Configuration

**You don't need any of this.** Configure only what you want to change.

Create `.unbraidrc.yaml` in your project, or `~/.config/unbraid/config.yaml` for everything.
The most common one:

```yaml
grouping:
  granularity: fine     # always small, per-file commits
```

<details>
<summary><b>Every setting</b> — every value shown is the default</summary>

```yaml
provider: auto              # auto | claude-cli | codex-cli | anthropic | openai-compatible
model: auto
updateCheck: true           # check npm once a day, in the background

providers:
  claude-cli:
    bin: claude
    extraArgs: []
  codex-cli:
    bin: codex
    model: auto             # auto lets codex pick its own
    extraArgs: []
  anthropic:
    baseUrl: https://api.anthropic.com   # or any host speaking the Messages API
    apiKeyEnv: ANTHROPIC_API_KEY
    model: claude-sonnet-5
  openai-compatible:
    baseUrl: https://api.openai.com/v1
    apiKeyEnv: OPENAI_API_KEY
    model: gpt-4o

grouping:
  granularity: semantic     # fine | semantic | coarse
  maxCommits: 20
  respectStaged: true       # already staged? left exactly as you set it
  hunks: false              # allow one file to split across commits
  expandUntrackedDirsUpTo: 10   # a new folder with more files counts as one item
  hints:                    # your rules, applied before the AI sees anything
    - match: "(package-lock.json|pnpm-lock.yaml|bun.lock)"
      group: "chore(deps): update lockfile"

message:
  format: conventional      # conventional | gitmoji | plain | auto
  types: [feat, fix, refactor, chore, docs, test, style, perf, build, ci]
  scope: auto               # auto | off | required
  maxTitleLength: 72
  body: auto                # always | never | auto
  bodyStyle: bullets        # bullets | prose
  language: en              # write messages in any language
  ticketPattern: null       # "([A-Z]+-\\d+)" lifts a ticket key from the branch name
  signOff: false

context:
  singlePassThreshold: 15   # at or under this, one faster AI call
  truncateLines: 20
  maxDiffBytes: 100000
  logSample: 20             # past commits read to learn your style
  exclude: ["*.lock", "*.min.js", "*.snap", "dist/**", "*.{png,jpg,svg,woff2}"]

execute:
  push: false
  pushRemote: origin
  autoconfirm: false        # skip the review screen, for scripts
  onError: rollback
  verify: true              # run your git hooks

pr:
  target: null              # null detects it: origin/HEAD, then main, master, develop
  offerAfterCommit: true    # after committing on a branch, offer to open a PR

guard:
  secrets: true             # stop before sending credential-like files to a cloud provider
  secretPatterns: [".env", ".env.*", "*.pem", "*_rsa", "*.key", "*.p12"]
```

Settings combine in layers, later winning:
**defaults → `~/.config/unbraid/config.yaml` → `.unbraidrc.yaml` → environment → flags**

`unbraid config` prints the result and where each value came from.

`exclude` means "don't spend tokens reading this" — those files are **still committed**.

</details>

### Message style

Conventional Commits by default — `type(scope): summary`:

```
feat(auth): add refresh token rotation
fix(api): handle null user in profile route
refactor: migrate from pages router to app router
```

Scopes are *encouraged, not required*. Forcing one on every commit is how you get `fix(fix):`.
unbraid also reads your last 20 commits and reuses the scopes and types already in use, so it
writes `ui` and `i18n` rather than inventing `frontend` and `translations`.

Prefer to match whatever the repo already does — plain sentences, emoji, anything? Set
`message.format: auto`.

---

## In your editor

The extension gives you the same engine with a panel of its own:

- Your changed files, with the icons and colours from your own theme
- Stage, unstage, discard, switch branch, sync — without opening Source Control
- The review panel: rename, merge, reorder, drop commits before anything is written
- **Undo the last run** — puts HEAD and your staging back exactly as they were
- `⌘⇧U` / `Ctrl+Shift+U` to start

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=aulianza.unbraid-vscode) ·
[Open VSX](https://open-vsx.org/extension/aulianza/unbraid-vscode) ·
[source](extension/)

## Scripting

Every part works without the interactive screen:

```bash
unbraid plan -o plan.json     # work out the commits, change nothing
$EDITOR plan.json             # edit by hand
unbraid apply --plan plan.json

unbraid pr --draft            # the PR text on stdout, nothing opened
```

Nothing opens a browser or asks a question when there's no terminal attached, so the same
commands are safe in a script or a CI job.

## Staying up to date

unbraid checks npm once a day, in the background, and mentions it after a command finishes:

```
Update available  0.8.0 → 0.9.0
npm i -g unbraid@latest
```

It never delays a run, and stays quiet in CI, when piped, when installed via `npx`, and **when
your provider runs on your own machine**. Turn it off with `updateCheck: false` or
`UNBRAID_NO_UPDATE_CHECK=1`. The check sends no identifier and nothing about you or your code.

---

## Troubleshooting

**`command not found: unbraid`**
`npm install -g unbraid`, or use `npx unbraid`.

**"No AI provider available"**
Run `unbraid init` — it walks the options and checks the result works.

**"Nothing to commit — the working tree is clean"**
No uncommitted changes. Edit something first.

**"A merge is in progress"**
Finish or abort it first. unbraid won't commit into a half-finished operation, because it
couldn't safely undo one.

**It's slow.**
Expected on the free CLI providers — each run starts a whole CLI. An API key is faster.

**It grouped things wrongly.**
Press `e` to rename, `m` to merge, `J`/`K` to reorder, `q` to throw the plan away. Nothing is
committed until you press `c`.

## Glossary

**Staging** — git's waiting room. Before committing you tell git which changes to include
(`git add`). Deciding what goes in each batch is the part unbraid automates.

**Atomic commit** — a commit that does one thing. Easier to review, easier to undo, and it
makes your history readable.

**Hunk** — one group of changed lines in a file. Change the top and the bottom and you have two.

**Conventional Commits** — the `type(scope): summary` format, like
`fix(auth): reject expired tokens`. Machines can build changelogs from it; humans can scan it.

**Working tree** — your project files as they are on disk right now.

---

## Status

**Early, but real.** Grouping, message generation, the review screen, commits with automatic
rollback, hunk-level splitting, PR drafting, and four providers all work and are covered by
tests.

Expect rough edges. Bug reports and pull requests genuinely welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md), and [ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it
works inside.

## License

[MIT](LICENSE) © [aulianza](https://aulianza.com)
