/**
 * Stall detection — the "why isn't it finished yet?" half of the protocol.
 *
 * A supervisor cannot tell a slow subordinate from a stuck one by looking at a
 * clock, so this module deliberately stops short of that judgement. It decides
 * *when* to look and *what to do next*, up to and including "go read the
 * transcript". Interpreting what the transcript shows is left to the
 * supervising model, which then records the outcome as an explicit action.
 *
 * Every function here is pure, so the whole chase ladder can be tested against
 * fixtures without launching a session.
 */

export const STATES = Object.freeze(['ok', 'quiet', 'stalled', 'blocked', 'lost', 'closed'])
export const ACTIONS = Object.freeze(['none', 'nudge', 'inspect', 'reassign'])

const TERMINAL = new Set(['done', 'failed', 'stopped', 'cancelled'])

export function classify (member, charter, now = Date.now()) {
  if (TERMINAL.has(member.status)) {
    return { state: 'closed', action: 'none', idle_minutes: 0, why: `member is ${member.status}` }
  }

  // A member that reported `blocked` is the most urgent case there is, and the
  // clock cannot see it: it has just spoken, so every silence-based check rates
  // it healthy while it sits waiting for a decision it cannot make itself.
  if (member.status === 'blocked') {
    const beyondCapability = member.report_reason === 'beyond_capability'
    return {
      state: 'blocked',
      action: beyondCapability ? 'reassign' : 'inspect',
      idle_minutes: idleMinutes(member, now),
      why: beyondCapability
        ? 'reported the task exceeds its model tier — re-dispatch one tier up'
        : `reported blocked${member.report_reason ? `: ${member.report_reason}` : ''} — read the report and unblock it`
    }
  }

  const { quiet_minutes, stall_minutes, lost_minutes, max_nudges } = charter.sla
  const idle = idleMinutes(member, now)

  if (idle < quiet_minutes) {
    return { state: 'ok', action: 'none', idle_minutes: idle, why: `heard from ${fmt(idle)} ago` }
  }

  if (idle < lost_minutes) {
    const state = idle < stall_minutes ? 'quiet' : 'stalled'

    // Nudge first — silence is usually just a long tool call. Only once the
    // cheap probe is exhausted is it worth paying to read the transcript.
    if (member.nudges < max_nudges) {
      return {
        state,
        action: 'nudge',
        idle_minutes: idle,
        why: `silent for ${fmt(idle)}, ${member.nudges}/${max_nudges} nudges sent`
      }
    }

    return {
      state,
      action: 'inspect',
      idle_minutes: idle,
      why: `silent for ${fmt(idle)} after ${member.nudges} nudges — read its output and judge whether it is progressing, looping, or blocked`
    }
  }

  return {
    state: 'lost',
    action: 'reassign',
    idle_minutes: idle,
    why: `silent for ${fmt(idle)}, past the ${lost_minutes}m lost threshold`
  }
}

export function idleMinutes (member, now = Date.now()) {
  const last = member.last_heartbeat ?? member.hired_at
  if (!last) return Infinity
  return Math.max(0, Math.round((now - Date.parse(last)) / 60000))
}

/** Classify every direct report of `parentId`, worst first. */
export function reviewTeam (org, charter, parentId, now = Date.now()) {
  const severity = { blocked: 0, lost: 1, stalled: 2, quiet: 3, ok: 4, closed: 5 }

  return org.members
    .filter(m => m.parent === parentId)
    .map(member => ({ member, ...classify(member, charter, now) }))
    .sort((a, b) => severity[a.state] - severity[b.state])
}

/** Anything a supervisor must act on this tick. */
export function needsAttention (review) {
  return review.filter(entry => entry.action !== 'none')
}

const fmt = minutes => (minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`)
