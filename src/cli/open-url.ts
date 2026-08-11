export interface Command {
  cmd: string
  args: string[]
}

export type Runner = (command: Command, input?: string) => Promise<void>

/**
 * The command that opens a URL in the user's default browser.
 *
 * Separated from execution so tests can assert the command per platform without
 * launching anything.
 */
export function browserCommand(url: string, platform: string): Command {
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  if (platform === 'win32') {
    // The empty string is `start`'s window-title argument. Without it, a URL in
    // quotes is treated as the title and no browser opens.
    return { cmd: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { cmd: 'xdg-open', args: [url] }
}

/** The command that reads stdin onto the clipboard, or null if unavailable. */
export function clipboardCommand(platform: string): Command | null {
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] }
  if (platform === 'win32') return { cmd: 'clip', args: [] }
  // Wayland and X11 differ; xclip is the most widely present.
  return { cmd: 'xclip', args: ['-selection', 'clipboard'] }
}

const defaultRunner: Runner = async ({ cmd, args }, input) => {
  const { spawn } = await import('node:child_process')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'],
      // Detached so closing the terminal does not close the browser.
      detached: input === undefined,
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    )
    if (input !== undefined) child.stdin?.end(input)
    else child.unref()
  })
}

export async function openUrl(
  url: string,
  platform = process.platform,
  run: Runner = defaultRunner,
): Promise<void> {
  await run(browserCommand(url, platform))
}

/**
 * Put text on the clipboard. Returns false rather than throwing.
 *
 * A missing clipboard tool is a minor inconvenience — the caller can print the
 * text instead — not a reason to fail the command.
 */
export async function copyToClipboard(
  text: string,
  platform = process.platform,
  run: Runner = defaultRunner,
): Promise<boolean> {
  const command = clipboardCommand(platform)
  if (!command) return false

  try {
    await run(command, text)
    return true
  } catch {
    return false
  }
}
