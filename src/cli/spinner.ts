const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function frameAt(index: number): string {
  return FRAMES[index % FRAMES.length]!
}

/**
 * Elapsed time, shown because runs take tens of seconds.
 *
 * A spinner alone proves the process is alive; it does not tell you whether
 * you are five seconds or two minutes in. With the Claude CLI provider carrying
 * several seconds of startup per call, that distinction is the difference
 * between waiting and reaching for ctrl-C.
 */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function renderLine(
  text: string,
  frameIndex: number,
  elapsedMs: number,
): string {
  return `${frameAt(frameIndex)} ${text} ${formatElapsed(elapsedMs)}`
}

export interface Spinner {
  start(text: string): void
  /** Change the message without interrupting the animation. */
  update(text: string): void
  /** Stop, replacing the line with a final message. */
  done(text?: string): void
  /** Stop and clear, leaving nothing behind. */
  stop(): void
}

export interface SpinnerOptions {
  stream?: NodeJS.WriteStream
  /** Force animation on or off. Defaults to whether the stream is a TTY. */
  animate?: boolean
  intervalMs?: number
  now?: () => number
}

/**
 * A single-line progress indicator on stderr.
 *
 * Writes to stderr so that `unbraid plan --json > plan.json` stays valid JSON.
 * When the stream is not a TTY — piped, redirected, or in CI — it degrades to
 * printing each message once rather than emitting thousands of control
 * sequences into a log file.
 */
export function createSpinner(options: SpinnerOptions = {}): Spinner {
  const stream = options.stream ?? process.stderr
  const animate = options.animate ?? Boolean(stream.isTTY)
  const intervalMs = options.intervalMs ?? 80
  const now = options.now ?? Date.now

  let timer: NodeJS.Timeout | null = null
  let frame = 0
  let text = ''
  let startedAt = 0
  let active = false

  const clear = () => {
    if (animate) stream.write('\r\u001b[2K')
  }

  const paint = () => {
    clear()
    stream.write(renderLine(text, frame++, now() - startedAt))
  }

  return {
    start(initial) {
      // Clearing first because start is called once per phase now, and each
      // call used to leave the previous interval running: stop() only ever
      // clears the newest timer, so the older ones kept painting over whatever
      // came next — including the full-screen review, which they scribbled
      // over while its prompt sat underneath.
      if (timer) clearInterval(timer)
      timer = null

      text = initial
      startedAt = now()
      active = true

      if (!animate) {
        stream.write(`${initial}\n`)
        return
      }

      stream.write('\u001b[?25l') // hide cursor
      paint()
      timer = setInterval(paint, intervalMs)
      // Never keep the process alive just to animate.
      timer.unref?.()
    },

    update(next) {
      if (!active) return
      text = next
      if (!animate) {
        stream.write(`${next}\n`)
        return
      }
      paint()
    },

    done(final) {
      if (!active) return
      active = false
      if (timer) clearInterval(timer)
      timer = null

      if (!animate) {
        if (final) stream.write(`${final}\n`)
        return
      }

      clear()
      stream.write('\u001b[?25h') // show cursor
      if (final) stream.write(`${final} ${formatElapsed(now() - startedAt)}\n`)
    },

    stop() {
      if (!active) return
      active = false
      if (timer) clearInterval(timer)
      timer = null
      if (animate) {
        clear()
        stream.write('\u001b[?25h')
      }
    },
  }
}
