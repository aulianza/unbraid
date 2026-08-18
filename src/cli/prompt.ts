import { createInterface } from 'node:readline/promises'

/**
 * Interactive prompts for the setup wizard.
 *
 * The key handling is split from the terminal work so it can be tested: the
 * reducer below is a pure function from key to new state, and everything that
 * touches stdin lives in the thin wrapper underneath it.
 */

export interface Key {
  name?: string
  ctrl?: boolean
  sequence?: string
}

export type SelectAction =
  | { type: 'move'; index: number }
  | { type: 'choose'; index: number }
  | { type: 'cancel' }
  | { type: 'ignore' }

/**
 * Interpret a keypress in a list.
 *
 * Arrows and j/k move, digits jump straight to an option, enter confirms.
 * Digits both move and confirm because typing "2" at a numbered list means
 * "I want the second one", not "highlight the second one".
 *
 * Movement wraps: at the bottom, down returns to the top. A list that silently
 * stops responding at its last item reads as broken.
 */
export function reduceSelect(key: Key, index: number, count: number): SelectAction {
  if (count === 0) return { type: 'ignore' }

  const name = key.name ?? ''

  if (name === 'return' || name === 'enter') return { type: 'choose', index }
  if (name === 'escape' || (key.ctrl && name === 'c')) return { type: 'cancel' }

  if (name === 'up' || name === 'k') {
    return { type: 'move', index: (index - 1 + count) % count }
  }
  if (name === 'down' || name === 'j') {
    return { type: 'move', index: (index + 1) % count }
  }
  if (name === 'home') return { type: 'move', index: 0 }
  if (name === 'end') return { type: 'move', index: count - 1 }

  const digit = Number(key.sequence)
  if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
    return { type: 'choose', index: digit - 1 }
  }

  return { type: 'ignore' }
}

export interface SelectOption {
  label: string
  hint?: string
}

/** Render the list. Separated from the loop so the output can be asserted. */
export function renderSelect(
  options: SelectOption[],
  index: number,
  paint: {
    cyan: (s: string) => string
    dim: (s: string) => string
    bold: (s: string) => string
  },
): string {
  const lines = options.flatMap((option, i) => {
    const selected = i === index
    const marker = selected ? paint.cyan('❯') : ' '
    const number = paint.dim(`${i + 1}.`)
    const label = selected ? paint.bold(option.label) : option.label
    const row = `  ${marker} ${number} ${label}`
    return option.hint ? [row, `       ${paint.dim(option.hint)}`] : [row]
  })

  return lines.join('\n')
}

/** How many terminal lines a rendered list occupies, for redrawing in place. */
export function selectHeight(options: SelectOption[]): number {
  return options.reduce((total, option) => total + (option.hint ? 2 : 1), 0)
}

/**
 * A yes/no question.
 *
 * The default is No unless stated otherwise, and non-interactive input takes
 * the default without asking. For anything consequential — creating commits,
 * sending credential-shaped files to a third party — keep the default of No.
 */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]'
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase()
    if (answer === '') return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}
