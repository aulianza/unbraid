import { describe, it, expect } from 'vitest'
import {
  buildCodexArgs,
  parseCodexOutput,
  createCodexCliProvider,
} from './codex-cli.js'
import { ProviderError } from './types.js'
import { resolveProvider } from './resolve.js'
import { defaultConfig } from '../config/schema.js'

const request = {
  system: 'You group files.',
  prompt: 'Group these files.',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
}

describe('buildCodexArgs', () => {
  it('runs exec with a schema file and an output file', () => {
    const args = buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'do it')

    expect(args[0]).toBe('exec')
    expect(args[args.indexOf('--output-schema') + 1]).toBe('/tmp/s.json')
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/o.json')
    // The prompt is positional and must come last.
    expect(args[args.length - 1]).toBe('do it')
  })

  // unbraid asks codex for a plan, never for actions. Read-only removes its
  // ability to run shell commands rather than trusting it not to.
  it('always sandboxes to read-only', () => {
    const args = buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'p')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  })

  it('never bypasses approvals', () => {
    const args = buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'p').join(' ')
    expect(args).not.toContain('dangerously')
  })

  it('runs anywhere, not only inside a repository', () => {
    expect(buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'p')).toContain(
      '--skip-git-repo-check',
    )
  })

  it('omits the model flag entirely when set to auto', () => {
    expect(buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'p', { model: 'auto' })).not.toContain('-m')
    expect(buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'p', {})).not.toContain('-m')
  })

  it('passes an explicit model through', () => {
    const args = buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'p', { model: 'o3' })
    expect(args[args.indexOf('-m') + 1]).toBe('o3')
  })

  it('keeps extra arguments before the prompt', () => {
    const args = buildCodexArgs('/tmp/s.json', '/tmp/o.json', 'the prompt', {
      extraArgs: ['--verbose'],
    })
    expect(args.indexOf('--verbose')).toBeLessThan(args.length - 1)
    expect(args[args.length - 1]).toBe('the prompt')
  })
})

describe('parseCodexOutput', () => {
  it('parses the written JSON', () => {
    expect(parseCodexOutput<{ groups: unknown[] }>('{"groups":[1,2]}').groups).toHaveLength(2)
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseCodexOutput('\n  {"ok":true}\n ')).toEqual({ ok: true })
  })

  // An empty output file means the run produced nothing, which is worth a
  // clearer message than a JSON parse error about position 0.
  it('explains an empty output file', () => {
    expect(() => parseCodexOutput('')).toThrow(/no output/)
  })

  it('fails clearly on non-JSON', () => {
    expect(() => parseCodexOutput('command not found')).toThrow(/not JSON/)
  })
})

describe('createCodexCliProvider', () => {
  const stub = (contents: string, onRun?: (args: string[]) => void) =>
    createCodexCliProvider({
      run: async (_bin, args) => onRun?.(args),
      readOutput: async () => contents,
    })

  it('returns the parsed result', async () => {
    await expect(stub('{"ok":true}').complete(request)).resolves.toEqual({ ok: true })
  })

  it('folds the system prompt into the prompt, since codex takes no system role', async () => {
    let seen: string[] = []
    await stub('{"ok":true}', (args) => (seen = args)).complete(request)

    const prompt = seen[seen.length - 1]!
    expect(prompt).toContain('You group files.')
    expect(prompt).toContain('Group these files.')
  })

  it('is not treated as remote, so the secret guard stays quiet', () => {
    expect(createCodexCliProvider().isRemote).toBe(false)
  })

  it('does not retry a missing binary', async () => {
    let calls = 0
    const provider = createCodexCliProvider({
      run: async () => {
        calls++
        const error = new Error('spawn codex ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
    })

    await expect(provider.complete(request)).rejects.toThrow(/not found on PATH/)
    expect(calls).toBe(1)
  })

  it('marks a missing binary as non-retryable', async () => {
    const provider = createCodexCliProvider({
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

  it('retries a transient failure', async () => {
    let calls = 0
    const provider = createCodexCliProvider({
      run: async () => {
        calls++
        if (calls < 2) throw new Error('temporary blip')
      },
      readOutput: async () => '{"ok":true}',
    })

    await expect(provider.complete(request)).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })
})

describe('resolveProvider with codex', () => {
  const config = () => defaultConfig()

  // Subscription-backed CLIs cost the user nothing beyond what they already
  // pay for, so they come before any provider that bills per token.
  it('prefers claude, then codex, then paid APIs', async () => {
    const both = await resolveProvider(config(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      claudeAvailable: async () => true,
      codexAvailable: async () => true,
    })
    expect(both.name).toBe('claude-cli')

    const codexOnly = await resolveProvider(config(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      claudeAvailable: async () => false,
      codexAvailable: async () => true,
    })
    expect(codexOnly.name).toBe('codex-cli')

    const neither = await resolveProvider(config(), {
      env: { ANTHROPIC_API_KEY: 'k' },
      claudeAvailable: async () => false,
      codexAvailable: async () => false,
    })
    expect(neither.name).toBe('anthropic')
  })

  it('honours an explicit codex-cli choice even when claude is installed', async () => {
    const chosen = defaultConfig()
    chosen.provider = 'codex-cli'

    const provider = await resolveProvider(chosen, {
      claudeAvailable: async () => true,
      codexAvailable: async () => true,
    })
    expect(provider.name).toBe('codex-cli')
  })

  it('mentions both CLIs when nothing is configured', async () => {
    await expect(
      resolveProvider(config(), {
        env: {},
        claudeAvailable: async () => false,
        codexAvailable: async () => false,
      }),
    ).rejects.toThrow(/codex/i)
  })
})
