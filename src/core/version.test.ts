import { describe, it, expect } from 'vitest'
import { compareVersions, isNewer } from './version.js'

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.1.0', '1.0.9', 1],
    ['2.0.0', '1.9.9', 1],
    ['0.7.0', '0.6.9', 1],
  ])('%s vs %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected)
  })

  // The bug this module exists to prevent. Comparing each component
  // independently calls 11.6.0 older than 11.5.1, because 0 < 1 in the patch.
  it('stops at the first differing component', () => {
    expect(isNewer('11.6.0', '11.5.1')).toBe(true)
    expect(isNewer('12.0.0', '11.5.1')).toBe(true)
    expect(isNewer('11.5.0', '11.5.1')).toBe(false)
    expect(isNewer('11.4.9', '11.5.1')).toBe(false)
  })

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.3', '1.2.9')).toBeGreaterThan(0)
  })

  it('ignores a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+build.9', '1.2.3')).toBe(0)
  })

  it('orders a prerelease before its release', () => {
    expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(true)
    expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false)
  })

  it('orders prereleases among themselves', () => {
    expect(isNewer('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
  })

  it('does not crash on malformed input', () => {
    expect(() => compareVersions('not-a-version', '1.0.0')).not.toThrow()
    expect(isNewer('', '1.0.0')).toBe(false)
  })
})
