import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeCharter } from '../src/nest/charter.mjs'
import { routeTask, correctRouting } from '../src/nest/routing.mjs'
import { classify, reviewTeam, needsAttention, idleMinutes } from '../src/nest/stall.mjs'
import { patternsOverlap, findConflicts, literalPrefix, negotiationExhausted } from '../src/nest/claims.mjs'

const charter = mergeCharter({ models: { roster: ['haiku', 'sonnet', 'opus'], floor: 'haiku', ceiling: 'opus', default: 'sonnet' } })

test('mechanical, fully specified work routes to the floor', () => {
  const { model } = routeTask({ mechanical: true, specified: true, scope: 'single-file', ambiguity: 'none' }, charter)
  assert.equal(model, 'haiku')
})

test('ambiguous cross-cutting debugging routes to the ceiling', () => {
  const { model } = routeTask({ ambiguity: 'high', unknown_root_cause: true, scope: 'cross-cutting' }, charter)
  assert.equal(model, 'opus')
})

test('an unremarkable task stays on the default tier', () => {
  const { model, rationale } = routeTask({}, charter)
  assert.equal(model, 'sonnet')
  assert.deepEqual(rationale, [])
})

test('routing never exceeds the charter ceiling however strong the signals', () => {
  const strict = mergeCharter({ models: { roster: ['haiku', 'sonnet'], floor: 'haiku', ceiling: 'sonnet', default: 'haiku' } })
  const { model, rationale } = routeTask({ ambiguity: 'high', unknown_root_cause: true, risk: 'irreversible', scope: 'cross-cutting' }, strict)

  assert.equal(model, 'sonnet', 'the human decides the ceiling, not the task')
  assert.ok(rationale.some(r => r.includes('clamped')))
})

test('prior failures escalate the tier', () => {
  assert.equal(routeTask({ prior_failures: 0 }, charter).model, 'sonnet')
  assert.equal(routeTask({ prior_failures: 1 }, charter).model, 'opus')
})

test('a tier missing from the roster falls back to the nearest available one', () => {
  const gapped = mergeCharter({ models: { ladder: ['haiku', 'sonnet', 'opus', 'fable'], roster: ['haiku', 'fable'], floor: 'haiku', ceiling: 'fable', default: 'haiku' } })
  const { model, rationale } = routeTask({ ambiguity: 'high' }, gapped)

  assert.equal(model, 'fable', 'prefer the more capable neighbour over silent under-provisioning')
  assert.ok(rationale.some(r => r.includes('not on the roster')))
})

test('beyond_capability escalates one tier', () => {
  const correction = correctRouting({ status: 'blocked', reason: 'beyond_capability' }, 'sonnet', charter)
  assert.deepEqual({ from: correction.from, to: correction.to, direction: correction.direction }, { from: 'sonnet', to: 'opus', direction: 'escalate' })
})

test('a trivially completed task de-escalates similar work', () => {
  const correction = correctRouting({ status: 'done', effort: 'trivial' }, 'opus', charter)
  assert.equal(correction.direction, 'de-escalate')
  assert.equal(correction.to, 'sonnet')
})

test('no correction is produced at the ends of the ladder', () => {
  assert.equal(correctRouting({ status: 'blocked', reason: 'beyond_capability' }, 'opus', charter), null)
  assert.equal(correctRouting({ status: 'done', effort: 'trivial' }, 'haiku', charter), null)
})

test('a single failure does not escalate, a second does', () => {
  assert.equal(correctRouting({ status: 'failed', attempt: 1 }, 'sonnet', charter), null)
  assert.equal(correctRouting({ status: 'failed', attempt: 2 }, 'sonnet', charter).to, 'opus')
})

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString()
const member = overrides => ({ id: 'm1', status: 'working', nudges: 0, last_heartbeat: ago(0), report_reason: null, ...overrides })

test('stall bands escalate with silence', () => {
  assert.equal(classify(member({ last_heartbeat: ago(1) }), charter).state, 'ok')
  assert.equal(classify(member({ last_heartbeat: ago(12) }), charter).state, 'quiet')
  assert.equal(classify(member({ last_heartbeat: ago(25) }), charter).state, 'stalled')
  assert.equal(classify(member({ last_heartbeat: ago(60) }), charter).state, 'lost')
})

test('nudges come before reading the transcript', () => {
  assert.equal(classify(member({ last_heartbeat: ago(12), nudges: 0 }), charter).action, 'nudge')
  assert.equal(classify(member({ last_heartbeat: ago(12), nudges: 2 }), charter).action, 'inspect')
})

test('a blocked member is urgent even though it just spoke', () => {
  const result = classify(member({ status: 'blocked', report_reason: 'beyond_capability', last_heartbeat: ago(0) }), charter)

  assert.equal(result.state, 'blocked', 'a talking-but-stuck member must not read as healthy')
  assert.equal(result.action, 'reassign')
})

test('a blocked member without a capability reason is inspected, not reassigned', () => {
  assert.equal(classify(member({ status: 'blocked', report_reason: 'missing_credentials' }), charter).action, 'inspect')
})

test('finished members need no action', () => {
  for (const status of ['done', 'failed', 'stopped', 'cancelled']) {
    const result = classify(member({ status }), charter)
    assert.equal(result.state, 'closed')
    assert.equal(result.action, 'none')
  }
})

test('a member that never reported is treated as infinitely idle', () => {
  assert.equal(idleMinutes({ last_heartbeat: null, hired_at: null }), Infinity)
  assert.equal(classify(member({ last_heartbeat: null, hired_at: null }), charter).state, 'lost')
})

test('team review sorts the most urgent first and lists only direct reports', () => {
  const org = {
    members: [
      { id: 'ok', parent: 'boss', status: 'working', nudges: 0, last_heartbeat: ago(1) },
      { id: 'blocked', parent: 'boss', status: 'blocked', nudges: 0, last_heartbeat: ago(0), report_reason: 'beyond_capability' },
      { id: 'lost', parent: 'boss', status: 'working', nudges: 2, last_heartbeat: ago(90) },
      { id: 'elsewhere', parent: 'other', status: 'working', nudges: 0, last_heartbeat: ago(90) }
    ]
  }

  const review = reviewTeam(org, charter, 'boss')
  assert.deepEqual(review.map(r => r.member.id), ['blocked', 'lost', 'ok'])
  assert.equal(needsAttention(review).length, 2)
})

test('overlapping path patterns are detected in both directions', () => {
  assert.equal(patternsOverlap('src/auth/**', 'src/auth/session.mjs'), true)
  assert.equal(patternsOverlap('src/auth/session.mjs', 'src/auth/**'), true)
  assert.equal(patternsOverlap('src/auth/a.mjs', 'src/billing/b.mjs'), false)
  assert.equal(patternsOverlap('src/auth/x.mjs', './src/auth/x.mjs'), true, 'normalisation handles ./ and separators')
  assert.equal(patternsOverlap('src\\auth\\x.mjs', 'src/auth/x.mjs'), true, 'windows separators normalise')
})

test('literal prefix stops at the first wildcard', () => {
  assert.equal(literalPrefix('src/auth/**'), 'src/auth/')
  assert.equal(literalPrefix('src/auth/session.mjs'), 'src/auth/')
  assert.equal(literalPrefix('*.mjs'), '')
})

test('a stopped member does not hold ground forever', () => {
  const claims = [{ claim_id: 'c1', pattern: 'hello.txt', owner: 'ghost', state: 'granted' }]

  assert.equal(findConflicts('hello.txt', claims, 'newcomer').length, 1, 'live by default')

  // Otherwise the newcomer negotiates with a peer that will never answer, then
  // escalates, and a supervisor has to rule on a one-sided dispute.
  const activeOwners = new Set(['newcomer'])
  assert.deepEqual(findConflicts('hello.txt', claims, 'newcomer', activeOwners), [])
})

test('conflicts exclude the requester and released claims', () => {
  const claims = [
    { claim_id: 'c1', pattern: 'src/auth/**', owner: 'alice', state: 'granted' },
    { claim_id: 'c2', pattern: 'src/auth/token.mjs', owner: 'bob', state: 'released' },
    { claim_id: 'c3', pattern: 'src/billing/**', owner: 'carol', state: 'granted' }
  ]

  assert.deepEqual(findConflicts('src/auth/session.mjs', claims, 'bob').map(c => c.claim_id), ['c1'])
  assert.deepEqual(findConflicts('src/auth/session.mjs', claims, 'alice'), [], 'you never conflict with yourself')
})

test('negotiation ends on exchange count or on peer silence', () => {
  assert.equal(negotiationExhausted(1, new Date().toISOString()).exhausted, false)
  assert.equal(negotiationExhausted(3, new Date().toISOString()).exhausted, true)
  assert.equal(negotiationExhausted(1, ago(5)).exhausted, true, 'a dead peer must not block progress forever')
})
