import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSpinner, formatElapsed, frameAt, renderLine } from './spinner.js'

/** Collects writes so output can be asserted without a terminal. */
function fakeStream(isTTY: boolean) {
  const writes: string[] = []
  return {
    writes,
    stream: {
      isTTY,
      write: (chunk: string) => {
        writes.push(chunk)
        return true
      },
    } as unknown as NodeJS.WriteStream,
  }
}

describe('formatElapsed', () => {
  it.each([
    [0, '0s'],
    [1_500, '1s'],
    [59_000, '59s'],
    [60_000, '1m 00s'],
    [67_700, '1m 07s'],
    [3_600_000, '60m 00s'],
  ])('%dms -> %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})

describe('frameAt', () => {
  it('cycles through the frames', () => {
    expect(frameAt(0)).toBe('⠋')
    expect(frameAt(10)).toBe(frameAt(0))
    expect(frameAt(1)).not.toBe(frameAt(0))
  })
})

describe('renderLine', () => {
  it('shows the frame, the message, and the elapsed time', () => {
    expect(renderLine('Grouping 10 files', 0, 12_000)).toBe('⠋ Grouping 10 files 12s')
  })
})

describe('createSpinner on a TTY', () => {
  it('animates on a timer', async () => {
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, intervalMs: 5, now: () => 0 })

    spinner.start('Working')
    await new Promise((resolve) => setTimeout(resolve, 30))
    spinner.stop()

    const frames = writes.filter((w) => w.includes('Working'))
    expect(frames.length).toBeGreaterThan(2)
  })

  it('hides the cursor while running and restores it after', () => {
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, now: () => 0 })

    spinner.start('Working')
    expect(writes.join('')).toContain('\u001b[?25l')

    spinner.stop()
    expect(writes.join('')).toContain('\u001b[?25h')
  })

  it('reports elapsed time on completion', () => {
    let clock = 0
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, now: () => clock })

    spinner.start('Working')
    clock = 67_700
    spinner.done('Done')

    expect(writes.join('')).toContain('Done 1m 07s')
  })

  it('rewrites one line rather than appending', () => {
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, now: () => 0 })

    spinner.start('First')
    spinner.update('Second')
    spinner.stop()

    // Each repaint clears the line first, so nothing scrolls.
    expect(writes.filter((w) => w.includes('\u001b[2K')).length).toBeGreaterThan(1)
  })

  it('ignores updates after stopping', () => {
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, now: () => 0 })

    spinner.start('Working')
    spinner.stop()
    const count = writes.length
    spinner.update('Ignored')

    expect(writes.length).toBe(count)
  })
})

describe('createSpinner without a TTY', () => {
  // Piped output and CI logs must not fill with control sequences.
  it('prints plain lines and emits no escape codes', () => {
    const { writes, stream } = fakeStream(false)
    const spinner = createSpinner({ stream, now: () => 0 })

    spinner.start('Grouping')
    spinner.update('Writing')
    spinner.done('Finished')

    const output = writes.join('')
    expect(output).toBe('Grouping\nWriting\nFinished\n')
    expect(output).not.toContain('\u001b')
  })
})

/**
 * Reported from a real run: the review screen appeared with a spinner still
 * ticking over it — "Reading 3 files and writing messages 1m 03s" painted on
 * top of the plan, with the keyboard prompt buried underneath.
 *
 * Each phase calls start(), and start() used to add an interval without
 * clearing the previous one. stop() only ever cleared the newest, so every
 * earlier phase left an animation running for the life of the process.
 */
describe('restarting', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves nothing running after a stop, however many phases ran', () => {
    vi.useFakeTimers()
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, animate: true, intervalMs: 10 })

    spinner.start('Reading your working tree')
    vi.advanceTimersByTime(50)
    spinner.start('Reading what changed')
    vi.advanceTimersByTime(50)
    spinner.start('Writing commit messages')
    vi.advanceTimersByTime(50)

    spinner.stop()
    const afterStop = writes.length
    vi.advanceTimersByTime(1000)

    expect(writes.length).toBe(afterStop)
  })

  it('paints one line per tick, not one per phase started', () => {
    vi.useFakeTimers()
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({ stream, animate: true, intervalMs: 10 })

    spinner.start('one')
    spinner.start('two')
    spinner.start('three')
    writes.length = 0

    vi.advanceTimersByTime(10)
    // One clear plus one line. Three overlapping timers produced six.
    expect(writes.length).toBe(2)
    expect(writes.join('')).toContain('three')
    expect(writes.join('')).not.toContain('one')

    spinner.stop()
  })

  it('restarts the elapsed clock for each phase', () => {
    let clock = 0
    const { writes, stream } = fakeStream(true)
    const spinner = createSpinner({
      stream,
      animate: true,
      intervalMs: 10_000,
      now: () => clock,
    })

    spinner.start('first')
    clock = 5_000
    spinner.start('second')

    expect(writes.join('')).toContain('second 0s')
    spinner.stop()
  })
})
