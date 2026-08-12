<div align="center">

<img src="https://raw.githubusercontent.com/aulianza/unbraid/master/assets/logo.png" alt="" width="72" height="72">

# unbraid for VS Code

**Turn a messy pile of changes into clean, well-described commits — without leaving the editor.**

</div>

---

You've been coding for a few hours. Source Control shows **52 changed files** and two bad
options: commit it all as "update stuff", or spend thirty minutes staging by hand.

unbraid reads every change, works out which ones belong together, writes a proper message for
each group, and shows you the plan before touching anything.

## How to use it

1. Make some changes.
2. Click the **unbraid** button in the Source Control title bar — or run
   **unbraid: Create commits** from the Command Palette.
3. Review the proposed commits: rename them, merge them, reorder them, drop the ones you don't
   want. Click a file to open its diff.
4. Press **Create commits**.

Nothing is committed until you press that button.

## Setup

If you have [Claude Code](https://claude.com/claude-code) installed and signed in, there is
nothing to configure — unbraid finds it and uses the subscription you already pay for. No API
key, no per-use charge.

Otherwise, run **unbraid: Set up a provider** from the Command Palette. It walks you through
the options — Anthropic, OpenAI, OpenRouter, Z.AI, Groq, DeepSeek, or a model running locally
on your own machine with Ollama — and checks the result works before you walk away.

## Undo

unbraid knows exactly which commits it just made, so it can take them back:

```
✓ unbraid created 5 commits.        [ Undo ]
```

Undo resets HEAD and restores the files you had staged, exactly as they were.
Your working files are never touched at any point, so nothing is lost either way.

It refuses if the branch has moved since — committing, pulling, or rebasing after a run means
an undo would discard work unbraid never created, and that is the one thing it must not do.

## Also in the panel

| | |
| --- | --- |
| `⌘⇧U` / `Ctrl+Shift+U` | Preview commits without reaching for the mouse |
| Branch switcher | Switch or create a branch, including remote-only ones |
| Recent commits | Browse the last 15 and open any of them as a diff |
| Sync | Pull with fast-forward only, then push |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `unbraid.granularity` | `semantic` | How big each commit is: `fine` (roughly per file), `semantic` (per feature or fix), or `coarse` |
| `unbraid.hunks` | `false` | Allow one file's changes to be split across commits when it mixes unrelated work |
| `unbraid.provider` | `auto` | Which AI writes the messages |

A repository's own `.unbraidrc.yaml` overrides these, so a project's convention beats a
personal editor preference.

## Two guarantees

**It never changes your files.** unbraid only stages and commits. If something fails halfway
through, every commit it made is undone and your staging is restored exactly as it was.

**It never loses a change.** AI models invent filenames, list the same file twice, and forget
others. unbraid checks every file the model mentions against your real changes — invented ones
are dropped, duplicates removed, and anything forgotten is shown to you rather than skipped.

## Also available as a CLI

Same engine, same behaviour:

```bash
npx unbraid
```

Full documentation, including hunk-level splitting and pull request drafting, is at
[github.com/aulianza/unbraid](https://github.com/aulianza/unbraid).

## License

MIT © [aulianza](https://aulianza.com)
