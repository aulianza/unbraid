import { describe, it, expect, afterEach } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseHunks,
  applyHunks,
  verifyRoundTrip,
  describeHunk,
  splitContent,
  joinContent,
  HunkError,
} from './hunks.js'
import { createTempRepo, type TempRepo } from './test-helpers.js'

let repo: TempRepo
afterEach(async () => {
  await repo?.cleanup()
})

const lines = (...l: string[]) => l.join('\n') + '\n'

describe('splitContent / joinContent', () => {
  it.each([
    ['a\nb\n', ['a', 'b'], true],
    ['a\nb', ['a', 'b'], false],
    ['', [], false],
    ['\n', [''], true],
  ])('round-trips %j', (text, expectedLines, endsWithNewline) => {
    const content = splitContent(text)
    expect(content.lines).toEqual(expectedLines)
    expect(content.endsWithNewline).toBe(endsWithNewline)
    expect(joinContent(content)).toBe(text)
  })
})

describe('parseHunks', () => {
  it('parses a single hunk', () => {
    const diff = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+B2', ' c'].join('\n')
    const [hunk] = parseHunks(diff, 'f.ts')

    expect(hunk!.oldStart).toBe(1)
    expect(hunk!.oldCount).toBe(3)
    expect(hunk!.newCount).toBe(4)
    expect(hunk!.insertions).toBe(2)
    expect(hunk!.deletions).toBe(1)
    expect(hunk!.id).toBe('f.ts#0')
  })

  it('parses several hunks and numbers them', () => {
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' b',
      '@@ -10,2 +10,2 @@',
      '-j',
      '+J',
      ' k',
    ].join('\n')

    const hunks = parseHunks(diff, 'f.ts')
    expect(hunks).toHaveLength(2)
    expect(hunks.map((h) => h.id)).toEqual(['f.ts#0', 'f.ts#1'])
    expect(hunks[1]!.oldStart).toBe(10)
  })

  it('treats a missing count as one line', () => {
    const [hunk] = parseHunks('@@ -5 +5 @@\n-a\n+A', 'f.ts')
    expect(hunk!.oldCount).toBe(1)
    expect(hunk!.newCount).toBe(1)
  })

  it('ignores the diff preamble', () => {
    const diff = [
      'diff --git a/f.ts b/f.ts',
      'index 83db48f..bf269f4 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1 +1 @@',
      '-a',
      '+A',
    ].join('\n')

    expect(parseHunks(diff, 'f.ts')).toHaveLength(1)
  })

  it('returns nothing for an empty diff', () => {
    expect(parseHunks('', 'f.ts')).toEqual([])
  })
})

describe('applyHunks', () => {
  const base = lines('one', 'two', 'three', 'four', 'five')

  it('applies a single hunk', () => {
    const hunks = parseHunks('@@ -2,1 +2,1 @@\n-two\n+TWO', 'f.ts')
    expect(applyHunks(base, hunks)).toBe(lines('one', 'TWO', 'three', 'four', 'five'))
  })

  it('applies only the hunks it is given', () => {
    const diff = [
      '@@ -1,1 +1,1 @@',
      '-one',
      '+ONE',
      '@@ -5,1 +5,1 @@',
      '-five',
      '+FIVE',
    ].join('\n')
    const hunks = parseHunks(diff, 'f.ts')

    // The whole point of hunk splitting: take the first change, leave the second.
    expect(applyHunks(base, [hunks[0]!])).toBe(
      lines('ONE', 'two', 'three', 'four', 'five'),
    )
    expect(applyHunks(base, [hunks[1]!])).toBe(
      lines('one', 'two', 'three', 'four', 'FIVE'),
    )
    expect(applyHunks(base, hunks)).toBe(
      lines('ONE', 'two', 'three', 'four', 'FIVE'),
    )
  })

  it('applies hunks in file order regardless of the order given', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-one', '+ONE', '@@ -5,1 +5,1 @@', '-five', '+FIVE'].join('\n')
    const [first, second] = parseHunks(diff, 'f.ts')

    expect(applyHunks(base, [second!, first!])).toBe(
      lines('ONE', 'two', 'three', 'four', 'FIVE'),
    )
  })

  it('handles pure insertions', () => {
    const hunks = parseHunks('@@ -2,0 +3,1 @@\n+inserted', 'f.ts')
    expect(applyHunks(base, hunks)).toBe(
      lines('one', 'two', 'inserted', 'three', 'four', 'five'),
    )
  })

  it('handles pure deletions', () => {
    const hunks = parseHunks('@@ -3,1 +2,0 @@\n-three', 'f.ts')
    expect(applyHunks(base, hunks)).toBe(lines('one', 'two', 'four', 'five'))
  })

  it('returns the base unchanged when given no hunks', () => {
    expect(applyHunks(base, [])).toBe(base)
  })

  it('handles a file with no trailing newline', () => {
    const noNewline = 'one\ntwo'
    const hunks = parseHunks(
      '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n\\ No newline at end of file',
      'f.ts',
    )
    expect(applyHunks(noNewline, hunks)).toBe('ONE\ntwo')
  })

  // Refusing beats guessing: applying a hunk whose context does not match is
  // how a tool commits something the user never wrote.
  it('refuses when context does not match', () => {
    const hunks = parseHunks('@@ -2,1 +2,1 @@\n-WRONG\n+TWO', 'f.ts')
    expect(() => applyHunks(base, hunks)).toThrow(HunkError)
    expect(() => applyHunks(base, hunks)).toThrow(/mismatch/)
  })

  it('refuses when hunks overlap', () => {
    const diff = ['@@ -1,3 +1,3 @@', '-one', '+ONE', ' two', ' three', '@@ -2,1 +2,1 @@', '-two', '+TWO'].join('\n')
    expect(() => applyHunks(base, parseHunks(diff, 'f.ts'))).toThrow(/overlap/)
  })

  it('refuses when a hunk starts past the end of the file', () => {
    const hunks = parseHunks('@@ -99,1 +99,1 @@\n-x\n+X', 'f.ts')
    expect(() => applyHunks(base, hunks)).toThrow(/past the end/)
  })
})

describe('verifyRoundTrip', () => {
  it('accepts a diff that reproduces the target exactly', () => {
    const base = lines('a', 'b')
    const target = lines('A', 'b')
    const hunks = parseHunks('@@ -1,1 +1,1 @@\n-a\n+A', 'f.ts')

    expect(verifyRoundTrip(base, hunks, target)).toBe(true)
  })

  it('rejects a diff that does not', () => {
    expect(
      verifyRoundTrip(lines('a'), parseHunks('@@ -1,1 +1,1 @@\n-a\n+A', 'f.ts'), lines('Z')),
    ).toBe(false)
  })

  it('rejects rather than throwing when the diff cannot be applied', () => {
    expect(
      verifyRoundTrip(lines('a'), parseHunks('@@ -9,1 +9,1 @@\n-x\n+X', 'f.ts'), lines('a')),
    ).toBe(false)
  })
})

describe('describeHunk', () => {
  it('uses the section heading when git provides one', () => {
    const [hunk] = parseHunks('@@ -10,3 +10,4 @@ function login() {\n a\n+b\n c', 'f.ts')
    expect(describeHunk(hunk!)).toContain('function login()')
  })

  it('falls back to a line range', () => {
    const [hunk] = parseHunks('@@ -10,3 +10,4 @@\n a\n+b\n c', 'f.ts')
    expect(describeHunk(hunk!)).toBe('lines 10-13')
  })
})

// Handcrafted diffs prove the parser handles what it was designed for. These
// prove it handles what git actually emits, which is the part that matters.
describe('round-trip against real git diffs', () => {
  const cases: Array<[string, string, string]> = [
    [
      'edits at both ends of a file',
      lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'),
      lines('ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'EIGHT'),
    ],
    [
      'an insertion in the middle',
      lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
      lines('a', 'b', 'c', 'd', 'INSERTED', 'e', 'f', 'g', 'h'),
    ],
    [
      'a deletion',
      lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
      lines('a', 'b', 'c', 'e', 'f', 'g', 'h'),
    ],
    [
      'losing the trailing newline',
      lines('a', 'b', 'c'),
      'a\nB\nc',
    ],
    [
      'gaining a trailing newline',
      'a\nb\nc',
      lines('a', 'B', 'c'),
    ],
    ['emptying a file', lines('a', 'b', 'c'), ''],
    ['filling an empty file', '', lines('a', 'b', 'c')],
    [
      'many scattered edits',
      lines(...Array.from({ length: 40 }, (_, i) => `line ${i}`)),
      lines(
        ...Array.from({ length: 40 }, (_, i) =>
          i % 7 === 0 ? `CHANGED ${i}` : `line ${i}`,
        ),
      ),
    ],
  ]

  it.each(cases)('%s', async (_name, before, after) => {
    repo = await createTempRepo()
    await writeFile(join(repo.dir, 'f.txt'), before)
    await repo.stage()
    await repo.commit('base')
    await writeFile(join(repo.dir, 'f.txt'), after)

    const diff = await repo.git.run(['diff', '--unified=3', '--', 'f.txt'])
    const hunks = parseHunks(diff, 'f.txt')
    const actualBase = await readFile(join(repo.dir, 'f.txt'), 'utf8').then(() => before)

    // Applying every hunk must reproduce the working tree byte for byte.
    expect(applyHunks(actualBase, hunks)).toBe(after)
    expect(verifyRoundTrip(actualBase, hunks, after)).toBe(true)
  })

  // Hand-written cases cover what I thought of. This covers what I did not:
  // 60 random edit patterns, each verified against real git output.
  it('survives randomised edits', async () => {
    repo = await createTempRepo()

    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 12345
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    for (let round = 0; round < 60; round++) {
      const size = 5 + Math.floor(random() * 40)
      const before = Array.from({ length: size }, (_, i) => `line ${i}`)
      const after: string[] = []

      for (const line of before) {
        const roll = random()
        if (roll < 0.15) continue // delete
        if (roll < 0.3) after.push(`CHANGED ${line}`)
        else after.push(line)
        if (random() < 0.12) after.push(`INSERTED after ${line}`)
      }

      const trailing = random() < 0.2 ? '' : '\n'
      const beforeText = before.join('\n') + trailing
      const afterText = after.join('\n') + (random() < 0.2 ? '' : '\n')

      await writeFile(join(repo.dir, 'fuzz.txt'), beforeText)
      await repo.git.run(['add', '-A', '--', 'fuzz.txt'])
      await repo.git.run(['commit', '-m', `round ${round}`, '--no-verify'])
      await writeFile(join(repo.dir, 'fuzz.txt'), afterText)

      const diff = await repo.git.run(['diff', '--unified=3', '--', 'fuzz.txt'])
      if (diff.trim() === '') continue // no change this round

      const hunks = parseHunks(diff, 'fuzz.txt')
      const rebuilt = applyHunks(beforeText, hunks)

      if (rebuilt !== afterText) {
        throw new Error(
          `round ${round} did not round-trip\n--- diff ---\n${diff}\n--- expected ---\n${JSON.stringify(afterText)}\n--- got ---\n${JSON.stringify(rebuilt)}`,
        )
      }
    }
  })

  it('each hunk applied alone produces a valid intermediate state', async () => {
    repo = await createTempRepo()
    const before = lines(...Array.from({ length: 30 }, (_, i) => `line ${i}`))
    const after = lines(
      ...Array.from({ length: 30 }, (_, i) =>
        i === 0 || i === 15 || i === 29 ? `CHANGED ${i}` : `line ${i}`,
      ),
    )

    await writeFile(join(repo.dir, 'f.txt'), before)
    await repo.stage()
    await repo.commit('base')
    await writeFile(join(repo.dir, 'f.txt'), after)

    const hunks = parseHunks(
      await repo.git.run(['diff', '--unified=3', '--', 'f.txt']),
      'f.txt',
    )
    expect(hunks.length).toBeGreaterThan(1)

    // Every hunk applies cleanly on its own, and the cumulative result of
    // applying them all in sequence equals the working tree.
    for (const hunk of hunks) {
      expect(() => applyHunks(before, [hunk])).not.toThrow()
    }
    expect(applyHunks(before, hunks)).toBe(after)
  })
})
