/**
 * Read a JSON body from an endpoint that is not strictly returning one.
 *
 * `response.json()` is the right call against a well-behaved server, and it is
 * what this used to do. Gateways are not always well-behaved. One in the wild
 * answers a non-streaming request with the complete object and an event-stream
 * terminator glued to the end:
 *
 *     {"id":"…","object":"chat.completion","choices":[…]}data: [DONE]
 *
 * served as `text/event-stream`. That is valid JSON followed by four bytes of
 * something else, so the parse fails on the trailing text and the user is told
 * "Unexpected non-whitespace character after JSON at position 556" — which
 * names neither the gateway nor the problem.
 *
 * Being liberal here is worth it. The alternative for anyone behind a proxy
 * that does this is that unbraid simply does not work, with an error that
 * reads like a bug in unbraid.
 */

/**
 * Pull the first complete JSON value out of a string.
 *
 * Scans for balanced braces rather than searching for a closing character,
 * because `}` appears inside strings constantly — every message body has one.
 * Returns null when there is no complete object.
 */
export function firstJsonValue(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const char = text[i]!

    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

/**
 * The payloads of an event stream, in order, ignoring its framing.
 *
 * `data: [DONE]` is a terminator, not a payload, and comment lines beginning
 * with `:` are keep-alives.
 */
export function sseFrames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((payload) => payload.length > 0 && payload !== '[DONE]')
}

export class ResponseParseError extends Error {
  constructor(readonly body: string) {
    super('the response was not JSON')
    this.name = 'ResponseParseError'
  }
}

/** Does the body open with event-stream framing rather than a value? */
function looksStreamed(text: string): boolean {
  return /^(data:|event:|id:|retry:|:)/.test(text)
}

/**
 * Parse a response body, tolerating the ways a gateway may dress it up.
 *
 * The order matters, and it follows what the body opens with:
 *
 *   - framing first means the frames are the payload, and the last complete one
 *     is the finished answer
 *   - anything else means the value comes first and whatever follows it is
 *     decoration, so the first complete value is the answer
 *
 * Reading the first value out of a real stream would otherwise return its
 * opening chunk — which parses, and says nothing.
 */
export function parseJsonBody<T>(text: string): T {
  const trimmed = text.trim()

  try {
    return JSON.parse(trimmed) as T
  } catch {
    // Not clean JSON. Keep going rather than failing on the strictest reading.
  }

  if (looksStreamed(trimmed)) {
    const frames = sseFrames(trimmed)
    for (let i = frames.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(frames[i]!) as T
      } catch {
        // Deltas are fragments; skip anything that will not stand alone.
      }
    }
  }

  const first = firstJsonValue(trimmed)
  if (first !== null) {
    try {
      return JSON.parse(first) as T
    } catch {
      // Balanced braces, but not valid JSON between them.
    }
  }

  throw new ResponseParseError(trimmed.slice(0, 300))
}
