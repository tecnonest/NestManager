import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSpawnArgs, roleBrief, adoptionBrief, resolveNestCommand, nestPermissionRules } from '../src/nest/hire.mjs'
import { quoteForCmd } from '../src/nest/spawn.mjs'
import { parseArgs } from '../src/nest/cli.mjs'

const base = {
  briefFile: '/nest/briefs/m1.md',
  assignmentFile: '/nest/assignments/m1.md',
  sessionId: 'm1',
  model: 'sonnet'
}

test('the session id is assigned by the parent, never discovered afterwards', () => {
  const { args, sessionId } = buildSpawnArgs(base)

  assert.equal(sessionId, 'm1')
  assert.equal(args[args.indexOf('--session-id') + 1], 'm1', 'the org chart is recorded before the child exists')
})

test('brief and assignment are passed as file paths, never inline', () => {
  const { args } = buildSpawnArgs(base)

  assert.ok(args.includes('--append-system-prompt-file'), 'a multi-line brief cannot survive as a cmd.exe argument')
  assert.ok(!args.includes('--append-system-prompt'))
  assert.ok(args.at(-1).includes('/nest/assignments/m1.md'), 'the prompt only points at the assignment')
  assert.ok(args.every(arg => !arg.includes('\n')), 'no argument may contain a newline')
})

test('bg mode is attachable and does not claim a harness-enforced budget', () => {
  const { args, budgetEnforcedByHarness } = buildSpawnArgs({ ...base, mode: 'bg', budgetUsd: 5 })

  assert.ok(args.includes('--bg'))
  assert.ok(!args.includes('--max-budget-usd'), 'the flag is print-mode only; passing it here would be a false guarantee')
  assert.equal(budgetEnforcedByHarness, false)
})

test('batch mode trades attachability for a real spend cap', () => {
  const { args, budgetEnforcedByHarness } = buildSpawnArgs({ ...base, mode: 'batch', budgetUsd: 5 })

  assert.ok(args.includes('--print'))
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '5')
  assert.equal(budgetEnforcedByHarness, true)
})

test('a plugin dir is forwarded so subordinates inherit hooks and role skills', () => {
  assert.ok(!buildSpawnArgs(base).args.includes('--plugin-dir'), 'an installed plugin needs no forwarding')

  const { args } = buildSpawnArgs({ ...base, pluginDir: '/opt/NestManager' })
  assert.equal(args[args.indexOf('--plugin-dir') + 1], '/opt/NestManager')
})

test('the Nest CLI is pre-authorised so the protocol cannot deadlock on approval', () => {
  const { args } = buildSpawnArgs(base)
  const rules = args[args.indexOf('--allowedTools') + 1]

  // A background subordinate has nobody to answer a permission prompt, so its
  // first `nest inbox` call would hang forever and read as a stall.
  assert.ok(rules.includes('Bash('), 'the shell tool must be pre-authorised')
  assert.ok(rules.includes('PowerShell('), 'Windows sessions reach for PowerShell, not Bash')
  assert.ok(!rules.includes(' '), 'variadic option: the rules must travel as one argument')
})

test('permission rules name whichever executable the brief tells members to run', () => {
  assert.deepEqual(nestPermissionRules('nest'), ['Bash(nest:*)', 'PowerShell(nest:*)'])
  assert.deepEqual(nestPermissionRules('node "/opt/nest/bin/nest.mjs"'), ['Bash(node:*)', 'PowerShell(node:*)'])
})

test('the prompt survives the variadic allowedTools option', () => {
  const { args } = buildSpawnArgs({ ...base, mode: 'bg' })

  // Learned the hard way against the real CLI: --allowedTools keeps consuming
  // past a boolean flag like --bg and eats the positional prompt, leaving the
  // session idle and waiting for input that never arrives. It stops cleanly
  // only at an option that takes a value of its own.
  assert.equal(args[0], '--allowedTools', 'emitting it first removes the ordering hazard entirely')
  assert.equal(args[2], '--session-id', 'and the option after it must take a value')
  assert.match(args.at(-1), /Read your assignment/, 'the prompt is still the final positional')
})

test('the ordering hazard is absent in batch mode too', () => {
  const { args } = buildSpawnArgs({ ...base, mode: 'batch', budgetUsd: 5 })
  assert.equal(args[2], '--session-id')
  assert.match(args.at(-1), /Read your assignment/)
})

test('a subordinate without a brief or an assignment is refused', () => {
  assert.throws(() => buildSpawnArgs({ ...base, briefFile: null }), /reports to/)
  assert.throws(() => buildSpawnArgs({ ...base, assignmentFile: null }), /assignmentFile/)
  assert.throws(() => buildSpawnArgs({ ...base, mode: 'sideways' }), /unknown dispatch mode/)
})

const briefContext = {
  memberId: 'm1', role: 'staff', tier: 2, parentId: 'boss', parentRole: 'manager',
  nestRoot: '/repo', model: 'sonnet', budgetUsd: 5, task: 'Rewrite the token validator'
}

test('the brief states identity, chain of command and the reporting duty', () => {
  const brief = roleBrief(briefContext)

  assert.match(brief, /Your member id: m1/)
  assert.match(brief, /You report to: manager \(boss\)/)
  assert.match(brief, /Rewrite the token validator/)
  assert.match(brief, /beyond_capability/, 'the escape hatch must be in the brief, not only in a skill')
  assert.match(brief, /Never hire subordinates of your own/, 'depth is not a subordinate decision')
})

test('the brief uses a CLI invocation that actually resolves', () => {
  const linked = roleBrief({ ...briefContext, nest: 'nest' })
  assert.match(linked, /`nest inbox --me m1`/)

  // Without a global link, `nest` is not on PATH and every protocol instruction
  // in the brief would fail silently.
  const unlinked = roleBrief({ ...briefContext, nest: 'node "/opt/nest/bin/nest.mjs"' })
  assert.match(unlinked, /node "\/opt\/nest\/bin\/nest\.mjs" inbox --me m1/)
  assert.ok(!/`nest inbox/.test(unlinked), 'no instruction may fall back to the unresolvable name')
})

test('the resolved command is either the linked binary or a runnable absolute path', () => {
  const resolved = resolveNestCommand()
  assert.ok(resolved === 'nest' || /^node ".*bin[\\/]nest\.mjs"$/.test(resolved), `unexpected: ${resolved}`)
})

test('an adoption brief supersedes the session prior understanding of its role', () => {
  const brief = adoptionBrief(briefContext)
  assert.match(brief, /enlisted into a NestManager hierarchy/)
  assert.match(brief, /supersedes any prior/)
})

test('cmd.exe quoting protects spaces, quotes and shell metacharacters', () => {
  assert.equal(quoteForCmd('simple'), 'simple')
  assert.equal(quoteForCmd('C:\\Program Files\\x'), '"C:\\Program Files\\x"')
  assert.equal(quoteForCmd(''), '""', 'an empty argument must survive as an argument')
  assert.ok(quoteForCmd('a&b').startsWith('"'), 'metacharacters must not reach the shell bare')
  assert.ok(quoteForCmd('say "hi"').includes('\\"'))
})

test('argument parsing distinguishes flags, values and positionals', () => {
  assert.deepEqual(
    parseArgs(['--status', 'done', '--json', '--summary=all good', 'extra']),
    { _: ['extra'], status: 'done', json: true, summary: 'all good' }
  )
})

test('a flag followed by another flag is boolean, not a value', () => {
  const args = parseArgs(['--dry-run', '--role', 'staff'])
  assert.equal(args['dry-run'], true, 'otherwise --dry-run would swallow --role')
  assert.equal(args.role, 'staff')
})
