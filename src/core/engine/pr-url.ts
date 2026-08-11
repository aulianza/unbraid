import type { Remote } from '../git/remote.js'

/**
 * Practical ceiling for a URL GitHub will accept.
 *
 * Well above what browsers handle and comfortably below where GitHub starts
 * returning 414, which surfaces to the user as a broken link rather than as
 * "your description was too long".
 */
export const MAX_URL_LENGTH = 8000

export interface CompareUrlInput {
  remote: Remote
  /** The branch being merged into. */
  target: string
  /** The branch being merged. */
  head: string
  title: string
  body: string
}

export interface CompareUrlPlan {
  url: string
  /** False when the body was left out to keep the URL short enough. */
  bodyIncluded: boolean
  /** Size of the body in bytes, for the message shown when it is dropped. */
  bodyBytes: number
}

/**
 * Build a GitHub "open a pull request" URL with the fields prefilled.
 *
 * This is the page reached by clicking "New pull request" by hand, with the
 * title and description already filled in — so it needs no CLI, no token, and
 * no authentication beyond already being logged into GitHub in the browser.
 *
 * When the body would push the URL past what GitHub accepts, the title is kept
 * and the body is dropped; the caller puts the full text on the clipboard. A
 * truncated description silently pasted into a PR would be worse than an
 * obvious extra paste step.
 */
export function planCompareUrl(input: CompareUrlInput): CompareUrlPlan {
  const bodyBytes = Buffer.byteLength(input.body, 'utf8')
  const withBody = buildUrl(input, true)

  if (withBody.length <= MAX_URL_LENGTH) {
    return { url: withBody, bodyIncluded: true, bodyBytes }
  }

  return { url: buildUrl(input, false), bodyIncluded: false, bodyBytes }
}

function buildUrl(input: CompareUrlInput, includeBody: boolean): string {
  const { remote, target, head } = input

  // Branch names may contain '/', which must survive as a path separator in the
  // compare spec but be escaped anywhere else.
  const compare = `${encodeBranch(target)}...${encodeBranch(head)}`
  const base = `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${compare}`

  const params = new URLSearchParams({ expand: '1', title: input.title })
  if (includeBody && input.body) params.set('body', input.body)

  return `${base}?${params.toString()}`
}

/**
 * Escape a branch name for a URL path, keeping '/' intact.
 *
 * `feature/PROJ-1` is one path segment to GitHub's compare route, so encoding
 * the slash would break it, but a '#' or '?' in a branch name must still be
 * escaped or it terminates the path.
 */
export function encodeBranch(branch: string): string {
  return branch
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** Explain why the body is not in the URL. */
export function describeDroppedBody(bodyBytes: number): string {
  const kb = (bodyBytes / 1024).toFixed(1)
  return `Description is too long for a URL (${kb} KB). Copied it to your clipboard — paste it into the description field.`
}
