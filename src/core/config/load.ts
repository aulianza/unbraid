import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { configSchema, type Config } from './schema.js'

/** Where a resolved value came from. Powers `unbraid config`. */
export type Source = 'default' | 'global' | 'repo' | 'env' | 'flag'

export interface LoadedConfig {
  config: Config
  /** Dotted key path → the layer that supplied it, for values not left at default. */
  provenance: Record<string, Source>
  /** Config files that were found and read, in precedence order. */
  filesRead: string[]
}

export interface LoadOptions {
  /** Repository root. Searched for a project config file. */
  cwd: string
  /** Overrides from CLI flags. Highest precedence. */
  flags?: DeepPartial<Config>
  /** Injected for testing. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Injected for testing. Defaults to the real home directory. */
  home?: string
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

const REPO_FILENAMES = [
  '.unbraidrc.yaml',
  '.unbraidrc.yml',
  '.unbraidrc.json',
  '.unbraidrc',
  'unbraid.config.yaml',
  'unbraid.config.json',
]

/**
 * Load configuration from every layer and merge it.
 *
 * Precedence, lowest to highest:
 *   built-in defaults → ~/.config/unbraid/config.yaml → repo config → env → flags
 *
 * Provenance is tracked alongside the merge so `unbraid config` can explain why
 * a value is what it is — the question every config system eventually gets asked.
 */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()

  const provenance: Record<string, Source> = {}
  const filesRead: string[] = []
  let merged: Record<string, unknown> = {}

  const globalPath = join(home, '.config', 'unbraid', 'config.yaml')
  const globalLayer = await readConfigFile(globalPath)
  if (globalLayer) {
    filesRead.push(globalPath)
    merged = mergeLayer(merged, globalLayer, 'global', provenance)
  }

  for (const name of REPO_FILENAMES) {
    const path = join(options.cwd, name)
    const repoLayer = await readConfigFile(path)
    if (repoLayer) {
      filesRead.push(path)
      merged = mergeLayer(merged, repoLayer, 'repo', provenance)
      break // first match wins; multiple config files would be ambiguous
    }
  }

  const envLayer = readEnvLayer(env)
  if (Object.keys(envLayer).length > 0) {
    merged = mergeLayer(merged, envLayer, 'env', provenance)
  }

  if (options.flags) {
    merged = mergeLayer(
      merged,
      options.flags as Record<string, unknown>,
      'flag',
      provenance,
    )
  }

  return { config: configSchema.parse(merged), provenance, filesRead }
}

async function readConfigFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null // absent is the normal case, not an error
  }

  try {
    // YAML is a superset of JSON, so one parser handles both extensions.
    const parsed = parseYaml(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null
  } catch (error) {
    throw new Error(
      `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Environment overrides for the handful of settings worth setting per-shell.
 *
 * Deliberately not a general UNBRAID_* → config mapping: that invites typos that
 * silently do nothing, which is worse than not supporting the variable at all.
 */
function readEnvLayer(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const layer: Record<string, unknown> = {}
  if (env.UNBRAID_PROVIDER) layer.provider = env.UNBRAID_PROVIDER
  if (env.UNBRAID_MODEL) layer.model = env.UNBRAID_MODEL
  return layer
}

/** Recursively merge one layer over the accumulator, recording provenance. */
function mergeLayer(
  base: Record<string, unknown>,
  layer: Record<string, unknown>,
  source: Source,
  provenance: Record<string, Source>,
  prefix = '',
): Record<string, unknown> {
  const result = { ...base }

  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue
    const path = prefix ? `${prefix}.${key}` : key

    if (isPlainObject(value)) {
      const existing = isPlainObject(result[key])
        ? (result[key] as Record<string, unknown>)
        : {}
      result[key] = mergeLayer(existing, value, source, provenance, path)
    } else {
      // Arrays replace rather than concatenate: appending to `exclude` would
      // make it impossible to remove a default entry.
      result[key] = value
      provenance[path] = source
    }
  }

  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}
