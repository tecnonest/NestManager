import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { nestPaths, ensureNestDirs } from '../src/nest/paths.mjs'
import { appendEvent, readEvents, projectOrg, appendInbox, readInbox } from '../src/nest/events.mjs'
import { mergeCharter, validateCharter, allocatableBudget, canHire, depthOf, DEFAULT_CHARTER } from '../src/nest/charter.mjs'

function tempNest () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-test-'))
  return ensureNestDirs(nestPaths(root))
}

test('event log survives a torn final line', () => {
  const paths = tempNest()
  appendEvent({ type: 'heartbeat', member: 'a' }, paths)
  fs.appendFileSync(paths.events, '{"type":"heartbeat","member":"b"') // no newline, no close

  const events = readEvents(paths)
  assert.equal(events.length, 1, 'the intact record is still readable')
  assert.equal(events[0].member, 'a')
})

test('events are ordered deterministically regardless of write order', () => {
  const paths = tempNest()
  const lines = [
    { id: 'ffff', ts: '2026-01-01T00:00:02.000Z', type: 'heartbeat', member: 'c' },
    { id: 'aaaa', ts: '2026-01-01T00:00:01.000Z', type: 'heartbeat', member: 'a' },
    { id: 'bbbb', ts: '2026-01-01T00:00:01.000Z', type: 'heartbeat', member: 'b' }
  ]
  fs.writeFileSync(paths.events, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

  assert.deepEqual(readEvents(paths).map(e => e.member), ['a', 'b', 'c'])
})

test('events sharing one millisecond fold in the order they were written', () => {
  const paths = tempNest()
  const ts = '2026-01-01T00:00:00.000Z'

  // A burst of events routinely lands in a single millisecond on a fast
  // machine. Ordering them by a random id made the projection depend on luck:
  // a report could fold before the nudges that preceded it.
  const lines = [
    { id: 'zzzz', ts, type: 'member_hired', member: 'm1', data: { role: 'staff' } },
    { id: 'yyyy', ts, type: 'nudge_sent', member: 'm1' },
    { id: 'xxxx', ts, type: 'nudge_sent', member: 'm1' },
    { id: 'aaaa', ts, type: 'report', member: 'm1', data: { status: 'done' } }
  ]
  fs.writeFileSync(paths.events, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

  const [member] = projectOrg(readEvents(paths)).members
  assert.equal(member.status, 'done', 'the last write wins, whatever the ids sort like')
  assert.equal(member.nudges, 0, 'the report clears nudges because it was written after them')
})

test('same-millisecond ordering is stable across repeated reads', () => {
  const paths = tempNest()
  const ts = '2026-01-01T00:00:00.000Z'
  const lines = Array.from({ length: 40 }, (_, i) => ({
    id: `id${String(40 - i).padStart(4, '0')}`, // ids deliberately descend
    ts,
    type: 'heartbeat',
    member: `m${String(i).padStart(2, '0')}`
  }))
  fs.writeFileSync(paths.events, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

  const first = readEvents(paths).map(e => e.member)
  const second = readEvents(paths).map(e => e.member)

  assert.deepEqual(first, second, 'two reads of one log must never disagree')
  assert.deepEqual(first, lines.map(l => l.member), 'and must match physical write order')
})

test('projection folds a hire, a heartbeat and a report into one member', () => {
  const paths = tempNest()
  appendEvent({ type: 'member_hired', member: 'm1', data: { role: 'staff', tier: 2, parent: 'boss', model: 'sonnet' } }, paths)
  appendEvent({ type: 'heartbeat', member: 'm1', data: { note: 'reading tests' } }, paths)
  appendEvent({ type: 'report', member: 'm1', data: { status: 'blocked', reason: 'beyond_capability' } }, paths)

  const [member] = projectOrg(readEvents(paths)).members
  assert.equal(member.role, 'staff')
  assert.equal(member.parent, 'boss')
  assert.equal(member.status, 'blocked')
  assert.equal(member.report_reason, 'beyond_capability', 'the reason must reach the stall classifier')
})

test('nudges accumulate and a report clears them', () => {
  const paths = tempNest()
  appendEvent({ type: 'member_hired', member: 'm1', data: { role: 'staff' } }, paths)
  appendEvent({ type: 'nudge_sent', member: 'm1' }, paths)
  appendEvent({ type: 'nudge_sent', member: 'm1' }, paths)
  assert.equal(projectOrg(readEvents(paths)).members[0].nudges, 2)

  appendEvent({ type: 'report', member: 'm1', data: { status: 'progress' } }, paths)
  assert.equal(projectOrg(readEvents(paths)).members[0].nudges, 0)
})

test('spend accumulates dollars and tokens independently', () => {
  const paths = tempNest()
  appendEvent({ type: 'member_hired', member: 'm1', data: { role: 'staff' } }, paths)
  appendEvent({ type: 'budget_spent', member: 'm1', data: { amount_usd: 0.4, tokens: 12_000 } }, paths)
  appendEvent({ type: 'budget_spent', member: 'm1', data: { amount_usd: 0.1, tokens: 3_000 } }, paths)
  // A spend recorded without a token count must not corrupt the token total.
  appendEvent({ type: 'budget_spent', member: 'm1', data: { amount_usd: 0.5 } }, paths)

  const [member] = projectOrg(readEvents(paths)).members
  assert.equal(Math.round(member.spent_usd * 100) / 100, 1)
  assert.equal(member.spent_tokens, 15_000)
})

test('a token guide is advisory and never blocks a hire', () => {
  const charter = mergeCharter({ budget: { total_usd: 100, total_tokens: 1000, reserve_pct: 0 } })
  const parent = { budget_usd: 100, spent_usd: 0, spent_tokens: 999_999 }

  // Only dollars gate allocation: a token count cannot bound a hierarchy that
  // mixes model tiers, since the same count costs wildly different amounts.
  assert.equal(allocatableBudget(parent, [], charter), 100)
  assert.deepEqual(validateCharter(charter), [])
})

test('a non-positive token guide is rejected', () => {
  const problems = validateCharter(mergeCharter({ budget: { total_tokens: 0 } }))
  assert.ok(problems.some(p => p.includes('total_tokens')))
})

test('unknown event types are rejected at the boundary', () => {
  const paths = tempNest()
  assert.throws(() => appendEvent({ type: 'promoted', member: 'm1' }, paths), /unknown event type/)
})

test('inbox is per-recipient and append-only', () => {
  const paths = tempNest()
  appendInbox('alice', { from: 'bob', body: 'one' }, paths)
  appendInbox('alice', { from: 'carol', body: 'two' }, paths)
  appendInbox('bob', { from: 'alice', body: 'three' }, paths)

  assert.deepEqual(readInbox('alice', paths).map(m => m.body), ['one', 'two'])
  assert.deepEqual(readInbox('bob', paths).map(m => m.body), ['three'])
  assert.deepEqual(readInbox('nobody', paths), [])
})

test('charter merge keeps defaults for untouched sections', () => {
  const merged = mergeCharter({ limits: { max_members: 20 } })
  assert.equal(merged.limits.max_members, 20)
  assert.equal(merged.limits.max_depth, DEFAULT_CHARTER.limits.max_depth, 'sibling keys survive')
  assert.deepEqual(merged.escalation, DEFAULT_CHARTER.escalation)
})

test('charter validation catches an unreachable ceiling and an inverted ladder', () => {
  assert.deepEqual(validateCharter(mergeCharter({})), [])

  const problems = validateCharter(mergeCharter({ models: { ceiling: 'gpt', floor: 'opus', default: 'sonnet' } }))
  assert.ok(problems.some(p => p.includes('ceiling')), 'a model off the ladder is rejected')
  assert.ok(problems.some(p => p.includes('floor ranks above')), 'an inverted range is rejected')
})

test('charter validation requires increasing SLA thresholds', () => {
  const problems = validateCharter(mergeCharter({ sla: { quiet_minutes: 30, stall_minutes: 10, lost_minutes: 45 } }))
  assert.ok(problems.some(p => p.includes('quiet < stall < lost')))
})

test('a parent cannot allocate its reserve away', () => {
  const charter = mergeCharter({ budget: { total_usd: 100, reserve_pct: 20 } })
  const parent = { budget_usd: 100, spent_usd: 0 }

  assert.equal(allocatableBudget(parent, [], charter), 80, '20% is withheld for escalations')
  assert.equal(allocatableBudget(parent, [{ budget_usd: 50 }], charter), 30)
  assert.equal(allocatableBudget({ budget_usd: 100, spent_usd: 40 }, [{ budget_usd: 50 }], charter), 0, 'never negative')
})

test('a finished subordinate releases the grant it did not spend', () => {
  const charter = mergeCharter({ budget: { total_usd: 100, reserve_pct: 20 } })
  const parent = { budget_usd: 100, spent_usd: 0 }

  const working = [{ budget_usd: 50, spent_usd: 3, status: 'working' }]
  assert.equal(allocatableBudget(parent, working, charter), 30, 'an active member ties up its whole grant')

  const finished = [{ budget_usd: 50, spent_usd: 3, status: 'done' }]
  assert.equal(allocatableBudget(parent, finished, charter), 77, 'a finished one ties up only what it spent')

  const stopped = [{ budget_usd: 50, spent_usd: 0, status: 'stopped' }]
  assert.equal(allocatableBudget(parent, stopped, charter), 80, 'a stopped member that never ran returns everything')
})

test('an uncapped charter reports no allocation limit', () => {
  const charter = mergeCharter({ budget: { total_usd: null } })
  assert.equal(allocatableBudget({ budget_usd: 0, spent_usd: 0 }, [], charter), null)
})

test('hiring gates on headcount, concurrency and depth independently', () => {
  const charter = mergeCharter({ limits: { max_members: 3, max_depth: 2, max_concurrent: 2 } })

  const roomy = { members: [{ id: 'exec', parent: null, status: 'working' }] }
  assert.equal(canHire(roomy, charter, 'exec').allowed, true)

  const crowded = {
    members: [
      { id: 'exec', parent: null, status: 'working' },
      { id: 'a', parent: 'exec', status: 'working' },
      { id: 'b', parent: 'exec', status: 'done' }
    ]
  }
  const verdict = canHire(crowded, charter, 'exec')
  assert.equal(verdict.allowed, false)
  assert.ok(verdict.reasons.some(r => r.includes('headcount')))
})

test('depth is measured through the parent chain and tolerates a cycle', () => {
  const org = {
    members: [
      { id: 'exec', parent: null },
      { id: 'mgr', parent: 'exec' },
      { id: 'staff', parent: 'mgr' }
    ]
  }
  assert.equal(depthOf(org, 'exec'), 0)
  assert.equal(depthOf(org, 'staff'), 2)

  const cyclic = { members: [{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }] }
  assert.ok(depthOf(cyclic, 'a') < 10, 'a corrupt parent chain must not hang the supervisor')
})
