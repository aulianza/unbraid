import { splitNul, type Git } from './exec.js'

const DEFAULT_MODE = '100644'

/**
 * Stage content that differs from what is on disk.
 *
 * `git add` can only stage a file as it currently exists, which makes it useless
 * for hunk-level splitting: commit 1 needs the file with only its own hunks
 * applied, while the working tree already holds every change. So the content is
 * written straight into the object store and the index is pointed at it.
 *
 * The working tree is never read or written here, which is what keeps unbraid's
 * "never modifies file contents" invariant true even in the hunk path.
 */
export async function stageContent(
  git: Git,
  path: string,
  content: string,
): Promise<string> {
  const mode = await fileMode(git, path)

  // `--path` so any clean/smudge filters and gitattributes for this path apply,
  // exactly as they would for a normal `git add`.
  const sha = (
    await git.runWithInput(['hash-object', '-w', '--stdin', '--path', path], content)
  ).trim()

  await git.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`])
  return sha
}

/** Read the content of a path as of a commit. Empty string when absent. */
export async function readAtCommit(
  git: Git,
  commit: string,
  path: string,
): Promise<string> {
  const result = await git.runRaw(['show', `${commit}:${path}`])
  return result.code === 0 ? result.stdout : ''
}

/**
 * Preserve the existing file mode so staging does not silently drop the
 * executable bit on a script.
 */
async function fileMode(git: Git, path: string): Promise<string> {
  const result = await git.runRaw(['ls-files', '--stage', '-z', '--', path])
  if (result.code !== 0) return DEFAULT_MODE

  const entry = splitNul(result.stdout)[0]
  const mode = entry?.split(' ')[0]
  return mode && /^\d{6}$/.test(mode) ? mode : DEFAULT_MODE
}
