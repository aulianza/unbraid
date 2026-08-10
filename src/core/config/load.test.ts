import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './load.js'
import { defaultConfig } from './schema.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unbraid-config-'))
  dirs.push(dir)
  return dir
}

describe('loadConfig', () => {
  it('works with no config file at all', async () => {
    const cwd = await scratch()
    const { config, filesRead } = await loadConfig({ cwd, env: {}, home: cwd })

    expect(filesRead).toEqual([])
    expect(config).toEqual(defaultConfig())
    expect(config.grouping.granularity).toBe('semantic')
    expect(config.execute.push).toBe(false)
  })

  it('reads a repo config file', async () => {
    const cwd = await scratch()
    await writeFile(
      join(cwd, '.unbraidrc.yaml'),
      'grouping:\n  granularity: fine\n  maxCommits: 5\n',
    )

    const { config, provenance } = await loadConfig({ cwd, env: {}, home: cwd })

    expect(config.grouping.granularity).toBe('fine')
    expect(config.grouping.maxCommits).toBe(5)
    expect(provenance['grouping.granularity']).toBe('repo')
    // Untouched keys keep their defaults.
    expect(config.message.maxTitleLength).toBe(72)
  })

  it('lets a repo config override the global one', async () => {
    const home = await scratch()
    const cwd = await scratch()
    await mkdir(join(home, '.config', 'unbraid'), { recursive: true })
    await writeFile(
      join(home, '.config', 'unbraid', 'config.yaml'),
      'model: global-model\nprovider: anthropic\n',
    )
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'model: repo-model\n')

    const { config, provenance } = await loadConfig({ cwd, env: {}, home })

    expect(config.model).toBe('repo-model')
    expect(provenance['model']).toBe('repo')
    // The global value survives where the repo said nothing.
    expect(config.provider).toBe('anthropic')
    expect(provenance['provider']).toBe('global')
  })

  it('lets environment variables override files', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'provider: anthropic\n')

    const { config, provenance } = await loadConfig({
      cwd,
      home: cwd,
      env: { UNBRAID_PROVIDER: 'claude-cli' },
    })

    expect(config.provider).toBe('claude-cli')
    expect(provenance['provider']).toBe('env')
  })

  it('lets flags override everything', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'provider: anthropic\n')

    const { config, provenance } = await loadConfig({
      cwd,
      home: cwd,
      env: { UNBRAID_PROVIDER: 'claude-cli' },
      flags: { provider: 'openai-compatible' },
    })

    expect(config.provider).toBe('openai-compatible')
    expect(provenance['provider']).toBe('flag')
  })

  it('replaces arrays rather than concatenating them', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'context:\n  exclude:\n    - "*.custom"\n')

    const { config } = await loadConfig({ cwd, env: {}, home: cwd })

    // Concatenating would make it impossible to drop a default entry.
    expect(config.context.exclude).toEqual(['*.custom'])
  })

  it('accepts JSON as well as YAML', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.json'), '{"message":{"language":"id"}}')

    const { config } = await loadConfig({ cwd, env: {}, home: cwd })
    expect(config.message.language).toBe('id')
  })

  it('names the offending file when parsing fails', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'grouping:\n  - [unclosed\n')

    await expect(loadConfig({ cwd, env: {}, home: cwd })).rejects.toThrow(
      /\.unbraidrc\.yaml/,
    )
  })

  it('rejects an invalid value instead of silently ignoring it', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'grouping:\n  granularity: whatever\n')

    await expect(loadConfig({ cwd, env: {}, home: cwd })).rejects.toThrow()
  })

  it('uses the first config filename it finds and ignores the rest', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, '.unbraidrc.yaml'), 'model: from-yaml\n')
    await writeFile(join(cwd, '.unbraidrc.json'), '{"model":"from-json"}')

    const { config, filesRead } = await loadConfig({ cwd, env: {}, home: cwd })

    expect(config.model).toBe('from-yaml')
    expect(filesRead).toHaveLength(1)
  })
})
