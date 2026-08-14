import { describe, it, expect } from 'vitest'
import { reduceSelect, renderSelect, selectHeight } from './prompt.js'

const plain = { cyan: (s: string) => s, dim: (s: string) => s, bold: (s: string) => s }
const options = [{ label: 'One' }, { label: 'Two', hint: 'a hint' }, { label: 'Three' }]

describe('reduceSelect', () => {
  it.each([
    ['down', 0, 1],
    ['up', 1, 0],
    ['j', 0, 1],
    ['k', 1, 0],
  ])('%s moves from %d to %d', (name, from, to) => {
    expect(reduceSelect({ name }, from, 3)).toEqual({ type: 'move', index: to })
  })

  // A list that stops responding at its last item reads as broken.
  it('wraps at both ends', () => {
    expect(reduceSelect({ name: 'down' }, 2, 3)).toEqual({ type: 'move', index: 0 })
    expect(reduceSelect({ name: 'up' }, 0, 3)).toEqual({ type: 'move', index: 2 })
  })

  it('jumps to the ends', () => {
    expect(reduceSelect({ name: 'home' }, 2, 3)).toEqual({ type: 'move', index: 0 })
    expect(reduceSelect({ name: 'end' }, 0, 3)).toEqual({ type: 'move', index: 2 })
  })

  // Typing "2" at a numbered list means "I want the second one", not
  // "highlight the second one".
  it('a digit selects and confirms in one keystroke', () => {
    expect(reduceSelect({ sequence: '2' }, 0, 3)).toEqual({ type: 'choose', index: 1 })
    expect(reduceSelect({ sequence: '1' }, 2, 3)).toEqual({ type: 'choose', index: 0 })
  })

  it('ignores a digit with no option behind it', () => {
    expect(reduceSelect({ sequence: '9' }, 0, 3)).toEqual({ type: 'ignore' })
    expect(reduceSelect({ sequence: '0' }, 0, 3)).toEqual({ type: 'ignore' })
  })

  it('enter confirms whatever is highlighted', () => {
    expect(reduceSelect({ name: 'return' }, 1, 3)).toEqual({ type: 'choose', index: 1 })
  })

  it.each([
    [{ name: 'escape' }],
    [{ name: 'c', ctrl: true }],
  ])('cancels on %j', (key) => {
    expect(reduceSelect(key, 0, 3)).toEqual({ type: 'cancel' })
  })

  it('ignores keys it has no meaning for', () => {
    expect(reduceSelect({ name: 'f5' }, 1, 3)).toEqual({ type: 'ignore' })
    expect(reduceSelect({ sequence: 'z' }, 1, 3)).toEqual({ type: 'ignore' })
  })

  it('ignores everything when the list is empty', () => {
    expect(reduceSelect({ name: 'down' }, 0, 0)).toEqual({ type: 'ignore' })
  })
})

describe('renderSelect', () => {
  it('marks the highlighted row and numbers them all', () => {
    const out = renderSelect(options, 1, plain)
    expect(out).toContain('❯ 2. Two')
    expect(out).toContain('1. One')
    expect(out).toContain('3. Three')
  })

  it('shows hints under their option', () => {
    expect(renderSelect(options, 0, plain)).toContain('a hint')
  })
})

describe('selectHeight', () => {
  // Redrawing in place depends on this being exactly right; one line out and
  // the list smears down the terminal on every keypress.
  it('counts a line per option and one more per hint', () => {
    expect(selectHeight(options)).toBe(4)
    expect(selectHeight([{ label: 'a' }, { label: 'b' }])).toBe(2)
  })
})
