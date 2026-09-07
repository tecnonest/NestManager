import test from 'node:test'
import assert from 'node:assert/strict'

import { displayNameFor, harnessIdFor, withHarnessIds } from '../src/nest/sessions.mjs'

// Shape taken from real `claude agents --json` output.
const SESSIONS = [
  { id: '0e971e78', status: 'waiting', name: 'staff:47efc65c' },
  { id: '80f42b1c', status: 'idle', name: 'manager:abab3b46' }
]

test('the display name is the bridge between the two id spaces', () => {
  assert.equal(displayNameFor('staff', '47efc65c-fc1c-48c6-8c11-2ad32c1bb967'), 'staff:47efc65c')
})

test('a member resolves to the harness id the CLI actually accepts', () => {
  const member = { id: '47efc65c-fc1c-48c6-8c11-2ad32c1bb967', role: 'staff' }

  // The org chart id is not what `claude logs` takes: --session-id is ignored
  // for background sessions, so the harness generated its own.
  assert.equal(harnessIdFor(member, SESSIONS), '0e971e78')
  assert.notEqual(harnessIdFor(member, SESSIONS), member.id)
})

test('role is part of the match, so two members cannot be confused', () => {
  const wrongRole = { id: '47efc65c-fc1c-48c6-8c11-2ad32c1bb967', role: 'manager' }
  assert.equal(harnessIdFor(wrongRole, SESSIONS), null)
})

test('an unresolvable member yields null rather than a plausible wrong id', () => {
  assert.equal(harnessIdFor({ id: 'ffffffff-0000-0000-0000-000000000000', role: 'staff' }, SESSIONS), null)
  assert.equal(harnessIdFor({ id: 'x', role: 'staff' }, []), null)
  assert.equal(harnessIdFor(null, SESSIONS), null)
  assert.equal(harnessIdFor({ id: 'x' }, SESSIONS), null, 'a member with no role cannot be matched')
})

test('enrichment marks unknown members instead of dropping them', () => {
  const members = [
    { id: '47efc65c-fc1c-48c6-8c11-2ad32c1bb967', role: 'staff' },
    { id: 'deadbeef-0000-0000-0000-000000000000', role: 'staff' }
  ]

  const enriched = withHarnessIds(members, SESSIONS)
  assert.equal(enriched.length, 2, 'a member the harness has never heard of is still a member')
  assert.equal(enriched[0].harness_id, '0e971e78')
  assert.equal(enriched[1].harness_id, null)
})
