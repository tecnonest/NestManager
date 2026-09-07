import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { nestPaths, ensureNestDirs } from './paths.mjs'

/**
 * The event log is the Nest's only source of truth.
 *
 * Every state change is one appended line. A dozen Claude sessions write here
 * concurrently with no coordination between them, so the log deliberately has
 * no global sequence number: assigning one would require a read-modify-write,
 * which is exactly the race we are avoiding. Ordering comes from the timestamp,
 * and `id` breaks ties deterministically so every reader folds the log the same
 * way.
 */

export const EVENT_TYPES = Object.freeze([
  'nest_initialised',
  'charter_set',
  'member_hired',
  'member_adopted',
  'assignment_given',
  'heartbeat',
  'report',
  'message',
  'claim_requested',
  'claim_granted',
  'claim_conflict',
  'claim_ruled',
  'stall_detected',
  'nudge_sent',
  'routing_correction',
  'member_stopped',
  'budget_allocated',
  'budget_spent'
])

export function appendEvent (event, paths = nestPaths()) {
  if (!EVENT_TYPES.includes(event.type)) {
    throw new Error(`unknown event type: ${event.type}`)
  }
  ensureNestDirs(paths)

  const record = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    ...event
  }

  // A single line-sized append is atomic on both POSIX and Windows, which is
  // what lets concurrent writers share this file without a lock.
  fs.appendFileSync(paths.events, JSON.stringify(record) + '\n', 'utf8')
  return record
}

/**
 * Read the log in a total order that is both deterministic and causal.
 *
 * Timestamps have millisecond resolution, and on a fast machine a burst of
 * events routinely shares one. Breaking those ties by the random `id` made the
 * projection non-deterministic: `nudge, nudge, report` could fold as
 * `report, nudge, nudge`, leaving a member that had just reported still counted
 * as un-nudged.
 *
 * Physical line order is the correct tie-break. Appends are atomic, so the
 * order lines appear in the file *is* the order they were written, across every
 * process writing concurrently.
 */
export function readEvents (paths = nestPaths()) {
  if (!fs.existsSync(paths.events) || !fs.statSync(paths.events).isFile()) return []

  const entries = []
  for (const [index, line] of fs.readFileSync(paths.events, 'utf8').split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push({ event: JSON.parse(trimmed), seq: index })
    } catch {
      // A torn final line can only happen if a writer died mid-append. Skipping
      // it is strictly better than refusing to read the whole Nest.
      process.emitWarning(`skipping malformed event at line ${index + 1}`)
    }
  }

  entries.sort((a, b) => (a.event.ts === b.event.ts ? a.seq - b.seq : a.event.ts < b.event.ts ? -1 : 1))
  return entries.map(entry => entry.event)
}

/**
 * Fold the event log into the current org chart.
 *
 * This is a projection, never authoritative state: `org.json` is only ever a
 * cache of what this function returns. If the two disagree, the log wins.
 */
export function projectOrg (events = readEvents()) {
  const members = new Map()
  const claims = new Map()
  const corrections = []

  const member = id => {
    if (!members.has(id)) {
      members.set(id, {
        id,
        role: 'unknown',
        tier: null,
        parent: null,
        session_id: null,
        model: null,
        status: 'unknown',
        task: null,
        budget_usd: 0,
        spent_usd: 0,
        spent_tokens: 0,
        hired_at: null,
        last_heartbeat: null,
        last_report: null,
        report_status: null,
        report_reason: null,
        nudges: 0,
        origin: null
      })
    }
    return members.get(id)
  }

  for (const e of events) {
    const d = e.data ?? {}
    switch (e.type) {
      case 'member_hired':
      case 'member_adopted': {
        Object.assign(member(e.member), {
          role: d.role ?? 'staff',
          tier: d.tier ?? null,
          parent: d.parent ?? null,
          session_id: d.session_id ?? null,
          model: d.model ?? null,
          task: d.task ?? null,
          status: 'working',
          hired_at: e.ts,
          last_heartbeat: e.ts,
          origin: e.type === 'member_hired' ? 'spawned' : 'adopted'
        })
        break
      }
      case 'assignment_given':
        Object.assign(member(e.member), { task: d.task ?? null, status: 'working', last_heartbeat: e.ts })
        break
      case 'heartbeat':
        Object.assign(member(e.member), { last_heartbeat: e.ts })
        break
      case 'report': {
        const m = member(e.member)
        m.last_report = e.ts
        m.last_heartbeat = e.ts
        m.status = d.status ?? 'done'
        // Carried on the projection so stall classification can act on *what*
        // was reported, not just how long ago it was heard.
        m.report_status = d.status ?? 'done'
        m.report_reason = d.reason ?? null
        m.nudges = 0
        break
      }
      case 'nudge_sent':
        member(e.member).nudges += 1
        break
      case 'stall_detected':
        member(e.member).status = 'stalled'
        break
      case 'member_stopped':
        Object.assign(member(e.member), { status: d.status ?? 'stopped' })
        break
      case 'budget_allocated':
        member(e.member).budget_usd += Number(d.amount_usd ?? 0)
        break
      case 'budget_spent':
        member(e.member).spent_usd += Number(d.amount_usd ?? 0)
        // Tokens are tracked alongside dollars but never enforced: only dollars
        // are comparable across model tiers, and only dollars have a cap the
        // harness will actually apply.
        member(e.member).spent_tokens += Number(d.tokens ?? 0)
        break
      case 'claim_requested':
      case 'claim_granted':
      case 'claim_conflict':
      case 'claim_ruled':
        claims.set(d.claim_id, {
          claim_id: d.claim_id,
          pattern: d.pattern ?? claims.get(d.claim_id)?.pattern ?? null,
          owner: d.owner ?? claims.get(d.claim_id)?.owner ?? e.member ?? null,
          state: e.type.replace('claim_', ''),
          decision: d.decision ?? claims.get(d.claim_id)?.decision ?? null,
          updated_at: e.ts
        })
        break
      case 'routing_correction':
        corrections.push({ ...d, ts: e.ts, member: e.member })
        break
    }
  }

  return {
    generated_at: new Date().toISOString(),
    members: [...members.values()],
    claims: [...claims.values()],
    routing_corrections: corrections
  }
}

export function writeOrgCache (org, paths = nestPaths()) {
  ensureNestDirs(paths)
  fs.writeFileSync(paths.org, JSON.stringify(org, null, 2) + '\n', 'utf8')
  return org
}

export function appendInbox (memberId, message, paths = nestPaths()) {
  ensureNestDirs(paths)
  const record = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    ...message
  }
  fs.appendFileSync(paths.inbox(memberId), JSON.stringify(record) + '\n', 'utf8')
  return record
}

export function readInbox (memberId, paths = nestPaths()) {
  const file = paths.inbox(memberId)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
}

export function writeReport (memberId, taskId, report, paths = nestPaths()) {
  const dir = paths.reports(memberId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${taskId}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return file
}
