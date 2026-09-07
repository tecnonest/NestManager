#!/usr/bin/env node
/**
 * Stop hook — the write guarantee.
 *
 * Fires when any session in the project finishes a turn. Its whole purpose is
 * to make reporting independent of the model: a subordinate that "forgets" to
 * report is irrelevant, because the harness files something either way.
 *
 * Two rules keep it from becoming noise:
 *
 *   spawned members  — a finished turn means finished work, so a member still
 *                      marked `working` stopped without reporting. That is a
 *                      real alarm and the supervisor is told.
 *   adopted members  — these are interactive sessions the human drives; ending
 *                      a turn is normal. They get a liveness heartbeat instead,
 *                      so they neither raise false alarms nor look stalled.
 *
 * It must never break a session: every path exits 0.
 */
import { nestPaths, findNestRoot, nestExists } from '../src/nest/paths.mjs'
import { appendEvent, readEvents, projectOrg, appendInbox, writeReport } from '../src/nest/events.mjs'

const OK = 0

async function main () {
  const payload = await readStdin()

  // The parent's assigned id wins over the harness session id. `--session-id`
  // is not honoured for background sessions, so the id the harness reports can
  // differ from the one recorded in the org chart — and looking up the wrong
  // one finds no member and silently files nothing, which is precisely the
  // failure this hook exists to prevent.
  const sessionId = process.env.NEST_MEMBER_ID || payload.session_id
  if (!sessionId) return

  const root = process.env.NEST_ROOT ?? findNestRoot(payload.cwd ?? process.cwd())
  const paths = nestPaths(root)
  if (!nestExists(paths)) return // not a Nest project — nothing to do

  // Set when Claude is only still running because a Stop hook blocked the turn.
  // We never block, but re-entering here would file a second report for one stop.
  if (payload.stop_hook_active) return

  const events = readEvents(paths)
  const org = projectOrg(events)
  const me = org.members.find(m => m.id === sessionId || m.session_id === sessionId)

  // Unknown session, or the Executive itself: the Executive reports to a human,
  // not to the Nest, and auto-filing on its behalf would be meaningless.
  if (!me || !me.parent) return

  // The model already reported this assignment to a terminal state. Filing over
  // the top of it would overwrite a considered report with a generic one.
  if (['done', 'failed', 'blocked', 'stopped', 'cancelled'].includes(me.status)) return

  if (me.origin === 'adopted') {
    appendEvent({ type: 'heartbeat', member: me.id, data: { note: 'turn ended (interactive session, still alive)', source: 'stop_hook' } }, paths)
    return
  }

  // An automatic report leaves the member in a non-terminal state, so a session
  // that ends several turns would raise the same alarm each time. Repeating it
  // tells the supervisor nothing new and buries the alarms that do matter.
  if (alreadyReportedWithNothingSince(events, me.id)) return

  const lastMessage = typeof payload.last_assistant_message === 'string'
    ? payload.last_assistant_message.trim()
    : null

  const report = {
    member: me.id,
    role: me.role,
    task_id: `auto-stop-${events.length}`,
    status: 'progress',
    summary: lastMessage
      ? `Session ended its turn without filing a report. Its last message was: ${excerpt(lastMessage)}`
      : 'Session ended its turn without filing a report. Filed automatically by the Stop hook.',
    reason: 'stopped_without_report',
    last_assistant_message: lastMessage,
    transcript: payload.transcript_path ?? null,
    reported_at: new Date().toISOString(),
    automatic: true
  }

  writeReport(me.id, report.task_id, report, paths)
  appendEvent({ type: 'report', member: me.id, data: report }, paths)

  appendInbox(me.parent, {
    from: me.id,
    kind: 'auto_report',
    subject: `${me.role} ${me.id.slice(0, 8)} stopped without reporting`,
    body: [
      'This session ended its turn while still marked as working, and filed no report of its own.',
      'It may have finished, run out of context, or died mid-task — the Nest cannot tell which.',
      lastMessage ? `\nIts last message was:\n${excerpt(lastMessage, 600)}\n` : '',
      `Inspect before assuming either: claude logs ${me.id}`,
      payload.transcript_path ? `Transcript: ${payload.transcript_path}` : ''
    ].filter(Boolean).join('\n')
  }, paths)
}

/** True when the newest event for this member is an automatic report. */
function alreadyReportedWithNothingSince (events, memberId) {
  const mine = events.filter(e => e.member === memberId)
  const newest = mine.at(-1)
  return newest?.type === 'report' && newest.data?.automatic === true
}

const excerpt = (text, limit = 300) =>
  text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`

function readStdin () {
  return new Promise(resolve => {
    let raw = ''
    // A hook invoked with no stdin must still complete rather than hang.
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
  await main()
} catch (error) {
  // Never let a bookkeeping failure interrupt real work.
  process.stdout.write(JSON.stringify({ systemMessage: `NestManager stop hook: ${error.message}` }))
}
process.exit(OK)
