import { describe, it, expect } from 'vitest'
import {
  buildClaudeArgs,
  parseClaudeResponse,
  createClaudeCliProvider,
  resolveModel,
} from './claude-cli.js'
import { ProviderError } from './types.js'

const request = {
  system: 'You group files.',
  prompt: 'Group these files.',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
}

describe('buildClaudeArgs', () => {
  it('requests JSON output with a schema', () => {
    const args = buildClaudeArgs(request)

    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('json')
    expect(args).toContain('--json-schema')
    expect(args[args.indexOf('--json-schema') + 1]).toBe(
      JSON.stringify(request.schema),
    )
  })

  // The next two are regression guards, not style checks. Both flags were
  // verified to break this adapter; see the comment in claude-cli.ts.
  it('never caps turns, which would null out structured_output', () => {
    expect(buildClaudeArgs(request)).not.toContain('--max-turns')
  })

  it('never passes --bare, which would break subscription auth', () => {
    expect(buildClaudeArgs(request)).not.toContain('--bare')
  })

  it('isolates the call from the user MCP servers and settings', () => {
    const args = buildClaudeArgs(request)
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--settings') + 1]).toBe('{}')
  })

  it('passes the system prompt through', () => {
    const args = buildClaudeArgs(request)
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('You group files.')
  })

  it('appends user-supplied extra arguments last', () => {
    const args = buildClaudeArgs(request, { extraArgs: ['--verbose'] })
    expect(args[args.length - 1]).toBe('--verbose')
  })
})

describe('resolveModel', () => {
  it('maps auto to a concrete model', () => {
    expect(resolveModel('auto')).toBe('sonnet')
    expect(resolveModel(undefined)).toBe('sonnet')
  })

  it('passes an explicit model through', () => {
    expect(resolveModel('claude-opus-5')).toBe('claude-opus-5')
  })
})

describe('parseClaudeResponse', () => {
  it('reads structured_output rather than result', () => {
    const stdout = JSON.stringify({
      is_error: false,
      // `result` is the same data as a string. Reading it would "work" here and
      // fail in production, where it can be prose.
      result: '{"groups":[]}',
      structured_output: { groups: [{ title: 'feat: a', files: ['a.ts'] }] },
    })

    const parsed = parseClaudeResponse<{ groups: unknown[] }>(stdout)
    expect(parsed.groups).toHaveLength(1)
  })

  it('fails clearly when structured_output is null', () => {
    const stdout = JSON.stringify({ is_error: false, structured_output: null })
    expect(() => parseClaudeResponse(stdout)).toThrow(/structured_output/)
  })

  it('surfaces an error envelope', () => {
    const stdout = JSON.stringify({ is_error: true, subtype: 'rate_limited' })
    expect(() => parseClaudeResponse(stdout)).toThrow(/rate_limited/)
  })

  it('fails clearly on non-JSON output', () => {
    expect(() => parseClaudeResponse('command not found')).toThrow(/not JSON/)
  })
})

describe('createClaudeCliProvider', () => {
  it('returns the parsed structured output', async () => {
    const provider = createClaudeCliProvider({
      run: async () =>
        JSON.stringify({ is_error: false, structured_output: { ok: true } }),
    })

    await expect(provider.complete(request)).resolves.toEqual({ ok: true })
  })

  it('is not treated as remote, so the secret guard stays quiet', () => {
    expect(createClaudeCliProvider().isRemote).toBe(false)
  })

  it('does not retry a missing binary', async () => {
    let calls = 0
    const provider = createClaudeCliProvider({
      run: async () => {
        calls++
        const error = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
    })

    await expect(provider.complete(request)).rejects.toThrow(/not found on PATH/)
    expect(calls).toBe(1)
  })

  it('retries a transient failure', async () => {
    let calls = 0
    const provider = createClaudeCliProvider({
      run: async () => {
        calls++
        if (calls < 2) throw new Error('temporary network blip')
        return JSON.stringify({ is_error: false, structured_output: { ok: true } })
      },
    })

    await expect(provider.complete(request)).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('marks a missing binary as non-retryable', async () => {
    const provider = createClaudeCliProvider({
      run: async () => {
        const error = new Error('nope') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
    })

    await provider.complete(request).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).retryable).toBe(false)
    })
  })
})
