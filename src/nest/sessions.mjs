import { execFileSync } from 'node:child_process'

/**
 * Map Nest members onto the live sessions the harness knows about.
 *
 * These are two different identifiers. `--session-id` is ignored for background
 * sessions, so the id in the org chart is not the id `claude logs`, `attach` and
 * `stop` expect. Without a translation the chase ladder hands a supervisor a
 * command that cannot work at precisely the moment it most needs to read a
 * subordinate's output.
 *
 * The bridge is the display name assigned at hire time — `staff:47efc65c` —
 * which embeds the first segment of the member id and is what `claude agents`
 * reports back.
 */

export function displayNameFor (role, memberId) {
  return `${role}:${memberId.slice(0, 8)}`
}

export function listSessions () {
  try {
    const raw = execFileSync('claude', ['agents', '--json', '--all'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32'
    })
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Discovery is an enhancement, never a dependency: the CLI may be absent,
    // slow, or newer than this parser. A supervisor with no live data still
    // gets a working status report.
    return []
  }
}

/** The harness id for a member, or null when it cannot be determined. */
export function harnessIdFor (member, sessions) {
  if (!member?.id || !member?.role) return null
  const tag = displayNameFor(member.role, member.id)

  const match = sessions.find(session => {
    const name = session.name ?? session.title ?? ''
    return name === tag
  })

  return match?.id ?? null
}

/**
 * Attach the live harness id to each member, leaving `harness_id` null where it
 * is unknown so callers can say so rather than printing a wrong command.
 */
export function withHarnessIds (members, sessions = listSessions()) {
  return members.map(member => ({ ...member, harness_id: harnessIdFor(member, sessions) }))
}
