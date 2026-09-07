import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { nestPaths, ensureNestDirs } from '../src/nest/paths.mjs'
import { appendEvent, readEvents, projectOrg, readInbox } from '../src/nest/events.mjs'
import { saveCharter } from '../src/nest/charter.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const STOP_HOOK = path.join(here, '..', 'hooks', 'stop-report.mjs')
const START_HOOK = path.join(here, '..', 'hooks', 'session-start-identity.mjs')

/** Run a hook exactly as Claude Code does: JSON on stdin, JSON or nothing on stdout. */
function runHook (hookPath, payload, root) {
  const stdout = execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, NEST_ROOT: root, NEST_MEMBER_ID: '' }
  })
  return stdout.trim() ? JSON.parse(stdout) : null
}

function nestWith (members) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-hook-'))
  const paths = ensureNestDirs(nestPaths(root))
  saveCharter({ objective: 'test engagement' }, paths)

  appendEvent({ type: 'member_hired', member: 'exec', data: { role: 'executive', tier: 0, parent: null } }, paths)
  for (const member of members) {
    appendEvent({
      type: member.origin === 'adopted' ? 'member_adopted' : 'member_hired',
      member: member.id,
      data: { role: member.role ?? 'staff', tier: 1, parent: member.parent ?? 'exec', model: 'sonnet', task: 'do the thing' }
    }, paths)
    if (member.status) appendEvent({ type: 'report', member: member.id, data: { status: member.status } }, paths)
  }
  return { root, paths }
}

test('a spawned member that stops without reporting is reported for it', () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned' }])

  runHook(STOP_HOOK, { session_id: 'worker', cwd: root, hook_event_name: 'Stop', transcript_path: '/tmp/t.jsonl' }, root)

  const org = projectOrg(readEvents(paths))
  const worker = org.members.find(m => m.id === 'worker')
  assert.equal(worker.report_reason, 'stopped_without_report', 'the model forgetting must not lose the signal')

  const supervisorInbox = readInbox('exec', paths)
  assert.equal(supervisorInbox.length, 1, 'the supervisor is told')
  assert.match(supervisorInbox[0].body, /claude logs worker/, 'and told how to investigate')
})

test('a member that already reported is not overwritten by the hook', () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned', status: 'done' }])

  runHook(STOP_HOOK, { session_id: 'worker', cwd: root, hook_event_name: 'Stop' }, root)

  const reports = readEvents(paths).filter(e => e.type === 'report' && e.member === 'worker')
  assert.equal(reports.length, 1, 'a considered report is never replaced by a generic one')
  assert.equal(reports[0].data.status, 'done')
  assert.equal(readInbox('exec', paths).length, 0, 'and no noise reaches the supervisor')
})

test("the subordinate's last message is carried into the report, not just a pointer", () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned' }])

  runHook(STOP_HOOK, {
    session_id: 'worker',
    cwd: root,
    hook_event_name: 'Stop',
    last_assistant_message: 'I rewrote the validator but two integration tests still fail on expiry handling.'
  }, root)

  const body = readInbox('exec', paths)[0].body
  assert.match(body, /two integration tests still fail/, 'the supervisor sees what was said, not a generic alarm')
})

test('a repeated stop with nothing in between does not raise a second alarm', () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned' }])
  const stop = () => runHook(STOP_HOOK, { session_id: 'worker', cwd: root, hook_event_name: 'Stop' }, root)

  stop()
  stop()
  stop()

  assert.equal(readInbox('exec', paths).length, 1, 'repeating an alarm buries the alarms that matter')
})

test('a stop that only happened because a hook blocked is ignored', () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned' }])

  runHook(STOP_HOOK, { session_id: 'worker', cwd: root, hook_event_name: 'Stop', stop_hook_active: true }, root)

  assert.equal(readInbox('exec', paths).length, 0, 'one stop must not produce two reports')
})

test('an adopted interactive member gets a heartbeat, not an alarm', () => {
  const { root, paths } = nestWith([{ id: 'adopted-one', origin: 'adopted' }])

  runHook(STOP_HOOK, { session_id: 'adopted-one', cwd: root, hook_event_name: 'Stop' }, root)

  const events = readEvents(paths).filter(e => e.member === 'adopted-one')
  assert.ok(events.some(e => e.type === 'heartbeat'), 'ending a turn proves it is alive')
  assert.ok(!events.some(e => e.type === 'report'), 'an interactive turn ending is not an alarm')
  assert.equal(readInbox('exec', paths).length, 0)
})

test('the Executive is never auto-reported on', () => {
  const { root, paths } = nestWith([])

  runHook(STOP_HOOK, { session_id: 'exec', cwd: root, hook_event_name: 'Stop' }, root)

  assert.equal(readEvents(paths).filter(e => e.type === 'report').length, 0, 'it reports to a human, not to the Nest')
})

test('a session outside any Nest is left completely alone', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-nest-'))
  const output = runHook(STOP_HOOK, { session_id: 'stranger', cwd: empty, hook_event_name: 'Stop' }, empty)
  assert.equal(output, null, 'no output, no state, no interference')
})

test('SessionStart restates identity and surfaces the inbox', () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned' }])
  appendEvent({ type: 'message', member: 'exec', data: { to: 'worker', kind: 'nudge' } }, paths)
  fs.appendFileSync(paths.inbox('worker'), JSON.stringify({ id: 'x', ts: new Date().toISOString(), from: 'exec', kind: 'nudge', body: 'status?' }) + '\n')

  const output = runHook(START_HOOK, { session_id: 'worker', cwd: root, hook_event_name: 'SessionStart' }, root)

  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart')
  const context = output.hookSpecificOutput.additionalContext
  assert.match(context, /member id `worker`/, 'a compacted session relearns who it is')
  assert.match(context, /1 unread message/, 'nothing else delivers the inbox into context')
  assert.match(context, /beyond_capability/, 'the escalation route is restated')
})

test('SessionStart tells a supervisor which reports need attention', () => {
  const { root, paths } = nestWith([{ id: 'worker', origin: 'spawned', parent: 'boss' }])
  appendEvent({ type: 'member_hired', member: 'boss', data: { role: 'manager', tier: 1, parent: 'exec' } }, paths)
  appendEvent({ type: 'report', member: 'worker', data: { status: 'blocked', reason: 'beyond_capability' } }, paths)

  const output = runHook(START_HOOK, { session_id: 'boss', cwd: root, hook_event_name: 'SessionStart' }, root)
  const context = output.hookSpecificOutput.additionalContext

  assert.match(context, /1 of your 1 direct report/)
  assert.match(context, /BLOCKED/, 'the urgent state is named on sight')
})

test('SessionStart stays silent outside a Nest', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-nest-'))
  assert.equal(runHook(START_HOOK, { session_id: 'stranger', cwd: empty }, empty), null)
})
