/**
 * VS Code settings become the flag layer of unbraid's config.
 *
 * That placement is deliberate: a repository's own `.unbraidrc.yaml` should keep
 * winning over a personal editor preference, exactly as the CLI documents. Only
 * values the user has actually set are forwarded, so an untouched setting stays
 * at its schema default rather than overriding the repo.
 */

export type Granularity = 'fine' | 'semantic' | 'coarse'

export interface ReadableSettings {
  /** Mirrors `WorkspaceConfiguration.inspect`, narrowed to what is needed. */
  inspect<T>(section: string): { workspaceValue?: T; globalValue?: T } | undefined
}

export interface FlagOverrides {
  provider?: string
  grouping?: { granularity?: Granularity; hunks?: boolean }
}

/**
 * Build the config override layer from settings the user explicitly set.
 *
 * `inspect` rather than `get`, because `get` always returns a value — the schema
 * default when nothing is set — and forwarding that would silently override a
 * repository's own configuration with a default the user never chose.
 */
export function readSettings(config: ReadableSettings): FlagOverrides {
  const explicit = <T>(section: string): T | undefined => {
    const found = config.inspect<T>(section)
    return found?.workspaceValue ?? found?.globalValue
  }

  const overrides: FlagOverrides = {}

  const provider = explicit<string>('provider')
  if (provider && provider !== 'auto') overrides.provider = provider

  const granularity = explicit<Granularity>('granularity')
  const hunks = explicit<boolean>('hunks')

  if (granularity !== undefined || hunks !== undefined) {
    overrides.grouping = {
      ...(granularity !== undefined ? { granularity } : {}),
      ...(hunks !== undefined ? { hunks } : {}),
    }
  }

  return overrides
}
