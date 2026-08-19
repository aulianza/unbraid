import { describe, it, expect } from 'vitest'
import {
  firstJsonValue,
  sseFrames,
  parseJsonBody,
  ResponseParseError,
} from './response-body.js'

/**
 * The body that started this, from a live gateway: a complete, non-streamed
 * chat.completion with an event-stream terminator glued to the end, served as
 * `text/event-stream`. `response.json()` failed on the four trailing bytes, and
 * the user was shown "Unexpected non-whitespace character after JSON at
 * position 556".
 */
const GATEWAY_BODY =
  '{"id":"69ec2dc4","object":"chat.completion","choices":[{"index":0,' +
  '"message":{"role":"assistant","tool_calls":[{"function":{"name":"respond",' +
  '"arguments":"{\\"ok\\":true}"}}]}}]}data: [DONE]\n\n'

describe('parseJsonBody', () => {
  it('reads a clean body', () => {
    expect(parseJsonBody('{"ok":true}')).toEqual({ ok: true })
  })

  it('reads the object a gateway appended [DONE] to', () => {
    const payload = parseJsonBody<{ choices: Array<Record<string, unknown>> }>(
      GATEWAY_BODY,
    )
    expect(payload.choices).toHaveLength(1)
  })

  it('reads an object wrapped in event-stream framing', () => {
    expect(parseJsonBody('data: {"ok":true}\n\ndata: [DONE]\n')).toEqual({ ok: true })
  })

  // Keep-alive comments are framing, not payload.
  it('ignores stream comments', () => {
    expect(parseJsonBody(': ping\n\ndata: {"ok":true}\n')).toEqual({ ok: true })
  })

  // In a stream carrying whole objects, the last frame is the finished answer.
  it('prefers the last complete frame', () => {
    const body = 'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n'
    expect(parseJsonBody<{ n: number }>(body).n).toBe(2)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseJsonBody('\n  {"ok":true}  \n')).toEqual({ ok: true })
  })

  it('reports a body that holds no JSON at all', () => {
    expect(() => parseJsonBody('<html>502 Bad Gateway</html>')).toThrow(ResponseParseError)
  })

  it('keeps the body on the error, so the message can show it', () => {
    try {
      parseJsonBody('upstream connect error')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ResponseParseError)
      expect((error as ResponseParseError).body).toContain('upstream connect error')
    }
  })
})

describe('firstJsonValue', () => {
  it('stops at the end of the first object', () => {
    expect(firstJsonValue('{"a":1}{"b":2}')).toBe('{"a":1}')
  })

  // A closing brace inside a string is not the end of the object, and message
  // bodies are full of them.
  it('is not fooled by braces inside strings', () => {
    expect(firstJsonValue('{"text":"} not the end {"}rest')).toBe(
      '{"text":"} not the end {"}',
    )
  })

  it('is not fooled by an escaped quote', () => {
    expect(firstJsonValue('{"text":"a \\" } b"}tail')).toBe('{"text":"a \\" } b"}')
  })

  it('handles nesting', () => {
    expect(firstJsonValue('{"a":{"b":{"c":1}}} trailing')).toBe('{"a":{"b":{"c":1}}}')
  })

  it('returns null when nothing is complete', () => {
    expect(firstJsonValue('{"a":1')).toBeNull()
    expect(firstJsonValue('no braces here')).toBeNull()
  })
})

describe('sseFrames', () => {
  it('takes the payloads and drops the framing', () => {
    expect(sseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n')).toEqual([
      '{"a":1}',
      '{"b":2}',
    ])
  })

  it('survives carriage returns', () => {
    expect(sseFrames('data: {"a":1}\r\ndata: [DONE]\r\n')).toEqual(['{"a":1}'])
  })

  it('is empty for a body that is not a stream', () => {
    expect(sseFrames('{"a":1}')).toEqual([])
  })
})
