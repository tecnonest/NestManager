import { spawn } from 'node:child_process'

/**
 * Launch a subordinate as a detached process.
 *
 * On Windows the `claude` entry point is a `.cmd` shim, which Node cannot
 * execute without a shell; on POSIX a shell is unnecessary and would only add
 * a quoting layer to get wrong. We therefore branch, and on Windows quote each
 * argument ourselves rather than trusting cmd.exe's parsing. Every argument we
 * pass is a flag, an identifier, or a file path — the multi-line content lives
 * in files precisely so this stays tractable.
 */
export function spawnDetached (command, args, { cwd, env } = {}) {
  const onWindows = process.platform === 'win32'

  const child = onWindows
    ? spawn(quoteForCmd(command), args.map(quoteForCmd), {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsVerbatimArguments: true
      })
    : spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdio: 'ignore'
      })

  // Release the child from the parent's event loop so `nest hire` can exit
  // immediately. A supervisor must never block on a subordinate's lifetime.
  child.unref()
  return child
}

/** Quote a single cmd.exe argument. Empty strings must still produce `""`. */
export function quoteForCmd (arg) {
  const value = String(arg)
  if (value !== '' && !/[\s"^&|<>()]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}
