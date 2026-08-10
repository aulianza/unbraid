/**
 * Unified-diff hunk parsing and application.
 *
 * This module is pure: strings in, strings out, no git and no filesystem. It is
 * the riskiest code in unbraid — a mistake here produces a commit whose contents
 * nobody asked for — so it is deliberately kept testable in isolation.
 *
 * Hunks are applied by rebuilding file content rather than by shelling out to
 * `git apply`. Applying a subset of hunks shifts the line offsets of every later
 * hunk, which makes patches fail or, worse, apply with fuzz in the wrong place.
 * Rebuilding from the base is deterministic and verifiable.
 */

export interface Hunk {
  /** Stable within one file+diff: `path#0`, `path#1`, … */
  id: string
  index: number
  /** 1-based line number in the base (pre-image) file. */
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** The `@@ … @@` line, kept for display. */
  header: string
  /** Body lines, each still carrying its ' ', '-', '+' or '\' prefix. */
  lines: string[]
  insertions: number
  deletions: number
}

export class HunkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HunkError'
  }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Split a unified diff into hunks.
 *
 * Everything before the first `@@` — the `---`/`+++` headers, `index` lines,
 * rename metadata — is discarded, since content is rebuilt from the base file
 * rather than fed back to `git apply`.
 */
export function parseHunks(diff: string, path: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null

  for (const line of diff.split('\n')) {
    const match = HUNK_HEADER.exec(line)

    if (match) {
      if (current) hunks.push(current)
      current = {
        id: `${path}#${hunks.length}`,
        index: hunks.length,
        oldStart: Number(match[1]),
        // "@@ -5 +5 @@" with no count means exactly one line.
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        header: line,
        lines: [],
        insertions: 0,
        deletions: 0,
      }
      continue
    }

    if (!current) continue // preamble

    const marker = line[0]
    if (marker === '+') current.insertions++
    else if (marker === '-') current.deletions++
    else if (marker !== ' ' && marker !== '\\' && line !== '') {
      // A line that is none of these means the diff body has ended.
      continue
    }
    current.lines.push(line)
  }

  if (current) hunks.push(current)
  return hunks
}

/** A file's content split for reconstruction, remembering its final newline. */
interface Content {
  lines: string[]
  endsWithNewline: boolean
}

export function splitContent(text: string): Content {
  if (text === '') return { lines: [], endsWithNewline: false }
  const endsWithNewline = text.endsWith('\n')
  const body = endsWithNewline ? text.slice(0, -1) : text
  return { lines: body.split('\n'), endsWithNewline }
}

export function joinContent(content: Content): string {
  if (content.lines.length === 0) return ''
  return content.lines.join('\n') + (content.endsWithNewline ? '\n' : '')
}

/**
 * Apply a subset of hunks to base content.
 *
 * Hunks are applied in base-file order regardless of the order given, because
 * the caller's order reflects commit grouping rather than position in the file.
 *
 * Throws `HunkError` when a hunk's context does not match the base. That means
 * the diff and the base disagree, and guessing at that point is how a tool
 * silently commits something the user never wrote.
 */
export function applyHunks(base: string, hunks: Hunk[]): string {
  const { lines: baseLines, endsWithNewline } = splitContent(base)
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart)

  const out: string[] = []
  let cursor = 0 // 0-based index into baseLines
  let finalNewline = endsWithNewline

  for (const hunk of ordered) {
    // A pure insertion is written `@@ -2,0 +3,1 @@`, where oldStart is the line
    // the new content goes *after*, not the line it replaces. Subtracting one
    // there inserts in the wrong place, and for `@@ -0,0` it goes negative.
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1

    if (start < cursor) {
      throw new HunkError(
        `Hunks overlap in ${hunk.id}: starts at line ${hunk.oldStart} but line ${cursor} was already consumed.`,
      )
    }
    if (start > baseLines.length) {
      throw new HunkError(
        `${hunk.id} starts at line ${hunk.oldStart}, past the end of a ${baseLines.length}-line file.`,
      )
    }

    out.push(...baseLines.slice(cursor, start))
    cursor = start

    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i]!
      const marker = line[0]
      const text = line.slice(1)

      if (marker === '\\') {
        // Handled after the loop: whether the *result* ends with a newline
        // depends on the hunk's new side, and a '\' marker can attach to
        // either side. Reading it inline gets the "base had none, result has
        // one" case backwards.
        continue
      }

      if (marker === ' ') {
        const actual = baseLines[cursor]
        if (actual !== text) {
          throw new HunkError(
            `Context mismatch in ${hunk.id} at line ${cursor + 1}: expected ${JSON.stringify(text)}, found ${JSON.stringify(actual)}.`,
          )
        }
        out.push(text)
        cursor++
      } else if (marker === '-') {
        const actual = baseLines[cursor]
        if (actual !== text) {
          throw new HunkError(
            `Removal mismatch in ${hunk.id} at line ${cursor + 1}: expected ${JSON.stringify(text)}, found ${JSON.stringify(actual)}.`,
          )
        }
        cursor++
      } else if (marker === '+') {
        out.push(text)
      }
    }

    // Only a hunk that runs to the end of the base file decides whether the
    // result ends with a newline; anything earlier is followed by base content.
    if (cursor >= baseLines.length) {
      const ending = newSideEndsWithNewline(hunk)
      if (ending !== null) finalNewline = ending
    }
  }

  out.push(...baseLines.slice(cursor))

  // A file whose last line came from a '+' with no trailing-newline marker
  // still ends with a newline if the base did and we did not consume the end.
  if (out.length === 0) finalNewline = false

  return joinContent({ lines: out, endsWithNewline: finalNewline })
}

/**
 * Whether this hunk's new side ends with a newline, or `null` if it says nothing.
 *
 * git writes `\ No newline at end of file` directly beneath the line it
 * describes, and that line can belong to either side. A hunk that removes the
 * last line of a file without a trailing newline and replaces it with one that
 * has a trailing newline carries the marker on its `-` line — so reading the
 * marker without checking which side it sits on gets that case exactly backwards.
 */
function newSideEndsWithNewline(hunk: Hunk): boolean | null {
  for (let i = hunk.lines.length - 1; i >= 0; i--) {
    const marker = hunk.lines[i]![0]
    // The new side is built from '+' and ' ' lines; '-' lines describe the base.
    if (marker === '+' || marker === ' ') {
      return hunk.lines[i + 1]?.[0] !== '\\'
    }
  }
  return null // deletions only: the ending comes from whatever precedes it
}

/**
 * Whether applying every hunk reproduces the expected content exactly.
 *
 * This is the safety gate for hunk-level splitting. If the round trip is not
 * byte-identical, unbraid does not understand this diff well enough to split it,
 * and the caller must fall back to committing the file whole.
 */
export function verifyRoundTrip(
  base: string,
  hunks: Hunk[],
  expected: string,
): boolean {
  try {
    return applyHunks(base, hunks) === expected
  } catch {
    return false
  }
}

/** A short human description, for the review screen. */
export function describeHunk(hunk: Hunk): string {
  const heading = hunk.header.split('@@')[2]?.trim()
  const range = `lines ${hunk.newStart}-${hunk.newStart + Math.max(hunk.newCount - 1, 0)}`
  return heading ? `${range} (${heading})` : range
}
