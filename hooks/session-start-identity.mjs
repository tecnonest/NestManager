#!/usr/bin/env node
/**
 * SessionStart hook — identity and pending messages.
 *
 * A member that has been compacted, resumed, or adopted mid-flight can easily
 * lose track of who it reports to. Its role brief was injected into the system
 * prompt once, and once is not a guarantee. This hook re-states the essentials
 * at the start of every session and surfaces anything waiting in the inbox,
 * because nothing else delivers inbox messages into a model's context.
 *
 * Silent for sessions that are not Nest members. Always exits 0.
 */
import { nestPaths, findNestRoot, nestExists } from '../src/nest/paths.mjs'
import { readEvents, projectOrg, readInbox } from '../src/nest/events.mjs'
import { loadCharter } from '../src/nest/charter.mjs'
import { classify } from '../src/nest/stall.mjs'

async function main () {
  const payload = await readStdin()
  // See stop-report.mjs: the parent's assigned id is authoritative, because a
  // background session's harness id is not the one we recorded.
  const sessionId = process.env.NEST_MEMBER_ID || payload.session_id
  if (!sessionId) return null

  const root = process.env.NEST_ROOT ?? findNestRoot(payload.cwd ?? process.cwd())
  const paths = nestPaths(root)
  if (!nestExists(paths)) return null

  const charter = loadCharter(paths)
  const org = projectOrg(readEvents(paths))
  const me = org.members.find(m => m.id === sessionId || m.session_id === sessionId)
  if (!me || !charter) return null

  const inbox = readInbox(me.id, paths)
  const team = org.members.filter(m => m.parent === me.id)
  const attention = team
    .map(member => ({ member, ...classify(member, charter) }))
    .filter(entry => entry.action !== 'none')

  const lines = [
    '# NestManager membership',
    '',
    `You are the **${me.role}** of this Nest (tier ${me.tier}), member id \`${me.id}\`.`,
    me.parent ? `You report to \`${me.parent}\`.` : 'You report to the human.',
    `Nest root: \`${paths.root}\``,
    ''
  ]

  if (inbox.length) {
    lines.push(
      `You have **${inbox.length} unread message(s)**. Read them before doing anything else:`,
      '```bash',
      `nest inbox --me ${me.id}`,
      '```',
      ''
    )
  }

  if (attention.length) {
    lines.push(`**${attention.length} of your ${team.length} direct report(s) need attention right now:**`, '')
    for (const { member, state, why } of attention) {
      lines.push(`- \`${member.id.slice(0, 8)}\` (${member.role}) — ${state.toUpperCase()}: ${why}`)
    }
    lines.push('', '```bash', `nest status --me ${me.id}`, '```', '')
  }

  if (me.parent) {
    lines.push(
      'Reporting is mandatory. When this assignment reaches a terminal state:',
      '```bash',
      `nest report --me ${me.id} --status done|failed|blocked --summary "<result>"`,
      '```',
      'If the work needs judgement beyond your model tier, report',
      '`--status blocked --reason beyond_capability` rather than guessing.'
    )
  }

  return lines.join('\n')
}

function readStdin () {
  return new Promise(resolve => {
    let raw = ''
    const bail = setTimeout(() => resolve({}), 2000)

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { raw += chunk })
    process.stdin.on('end', () => {
      clearTimeout(bail)
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
    process.stdin.on('error', () => { clearTimeout(bail); resolve({}) })
  })
}

try {
  const context = await main()
  if (context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
    }))
  }
} catch {
  // A member that cannot be identified is better served by a normal session
  // than by a failed one.
}
process.exit(0)
