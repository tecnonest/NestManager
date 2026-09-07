import fs from 'node:fs'
import path from 'node:path'
import { nestPaths, ensureNestDirs, nestExists, findNestRoot } from './paths.mjs'
import { appendEvent, readEvents, projectOrg, writeOrgCache, appendInbox, readInbox, writeReport } from './events.mjs'
import { loadCharter, saveCharter, DEFAULT_CHARTER, allocatableBudget, canHire, depthOf } from './charter.mjs'
import { routeTask, correctRouting } from './routing.mjs'
import { classify, reviewTeam, needsAttention } from './stall.mjs'
import { findConflicts, claimId } from './claims.mjs'
import { buildSpawnArgs, roleBrief, adoptionBrief, newMemberId } from './hire.mjs'
import { spawnDetached } from './spawn.mjs'
import { listSessions, harnessIdFor } from './sessions.mjs'

const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped', 'cancelled'])

class NestError extends Error {}
const fail = message => { throw new NestError(message) }

function context (args) {
  const paths = nestPaths(findNestRoot())
  const charter = loadCharter(paths)
  const events = nestExists(paths) ? readEvents(paths) : []
  const org = projectOrg(events)
  const meId = args.me ?? process.env.NEST_MEMBER_ID ?? null
  const me = meId ? org.members.find(m => m.id === meId) ?? null : null
  return { paths, charter, events, org, meId, me }
}

const requireNest = ctx => ctx.charter ?? fail('no Nest here — run `nest init` first')
const requireMe = ctx => ctx.meId ?? fail('who are you? pass --me <member-id> or set NEST_MEMBER_ID')

export const commands = {
  /** Create the Nest, write the Charter, and register the Executive. */
  init (args) {
    const paths = ensureNestDirs(nestPaths(findNestRoot()))
    if (fs.existsSync(paths.charter) && !args.force) {
      fail(`a Charter already exists at ${paths.charter} — pass --force to replace it`)
    }

    const charter = saveCharter(buildCharterFrom(args), paths)
    const executiveId = args.me ?? newMemberId()

    appendEvent({ type: 'nest_initialised', member: executiveId, data: { root: paths.root } }, paths)
    appendEvent({ type: 'charter_set', member: executiveId, data: { objective: charter.objective } }, paths)
    appendEvent({
      type: 'member_hired',
      member: executiveId,
      data: { role: 'executive', tier: 0, parent: null, session_id: args['session-id'] ?? null, model: args.model ?? null, task: charter.objective, origin: 'root' }
    }, paths)

    if (charter.budget.total_usd !== null) {
      appendEvent({ type: 'budget_allocated', member: executiveId, data: { amount_usd: charter.budget.total_usd, from: 'charter' } }, paths)
    }

    writeOrgCache(projectOrg(readEvents(paths)), paths)

    return [
      `Nest initialised at ${paths.nest}`,
      `Executive member id: ${executiveId}`,
      '',
      'Record that id — every command you run needs `--me <id>`, or export NEST_MEMBER_ID.',
      '',
      renderCharter(charter)
    ].join('\n')
  },

  charter (args) {
    const ctx = context(args)
    if (args._[0] === 'set') {
      const merged = saveCharter({ ...(ctx.charter ?? DEFAULT_CHARTER), ...buildCharterFrom(args) }, ctx.paths)
      appendEvent({ type: 'charter_set', member: requireMe(ctx), data: { objective: merged.objective } }, ctx.paths)
      return renderCharter(merged)
    }
    return renderCharter(requireNest(ctx))
  },

  whoami (args) {
    const ctx = context(args)
    requireNest(ctx)
    const me = ctx.me ?? fail(`no member ${requireMe(ctx)} in this Nest`)
    const team = ctx.org.members.filter(m => m.parent === me.id)
    return [
      `${me.role} (tier ${me.tier}) — ${me.id}`,
      `status: ${me.status}${me.model ? ` · model: ${me.model}` : ''}`,
      me.parent ? `reports to: ${me.parent}` : 'reports to: the human',
      `direct reports: ${team.length || 'none'}`,
      me.task ? `\nassignment:\n${me.task}` : ''
    ].join('\n')
  },

  /** Spawn a new subordinate session. */
  hire (args) {
    const ctx = context(args)
    const charter = requireNest(ctx)
    const parentId = requireMe(ctx)
    const parent = ctx.me ?? fail(`no member ${parentId} in this Nest`)

    const role = args.role ?? (depthOf(ctx.org, parentId) === 0 ? 'manager' : 'staff')
    const task = readTask(args)

    const gate = canHire(ctx.org, charter, parentId)
    if (!gate.allowed && !args.force) fail(`cannot hire: ${gate.reasons.join('; ')}`)

    const routed = args.model
      ? { model: args.model, rationale: ['explicitly specified by supervisor'] }
      : routeTask(signalsFrom(args), charter)

    const children = ctx.org.members.filter(m => m.parent === parentId)
    const available = allocatableBudget(parent, children, charter)
    const budgetUsd = args.budget !== undefined ? Number(args.budget) : available
    if (available !== null && budgetUsd > available) {
      fail(`budget $${budgetUsd} exceeds your allocatable $${available} (reserve withheld for escalations)`)
    }

    const memberId = newMemberId()
    const tier = depthOf(ctx.org, parentId) + 1
    const brief = roleBrief({
      memberId, role, tier, parentId, parentRole: parent.role,
      nestRoot: ctx.paths.root, model: routed.model, budgetUsd, task
    })

    const plan = buildSpawnArgs({
      sessionId: memberId,
      model: routed.model,
      budgetUsd,
      briefFile: ctx.paths.brief(memberId),
      assignmentFile: ctx.paths.assignment(memberId),
      displayName: args.name ?? `${role}:${memberId.slice(0, 8)}`,
      worktree: args.worktree ?? null,
      permissionMode: args['permission-mode'] ?? null,
      mode: args.mode ?? 'bg',
      pluginDir: verifiedPluginDir(charter.plugin_dir)
    })

    // Checked before anything is written: a dry run must leave no trace, or it
    // litters the Nest with briefs for members that were never hired.
    if (args['dry-run']) {
      return [
        `would run: ${plan.command} ${plan.args.join(' ')}`,
        '',
        `model:  ${routed.model} (${routed.rationale.join('; ')})`,
        `budget: ${budgetUsd === null ? 'uncapped' : `$${budgetUsd}`} of $${available ?? '∞'} allocatable`
      ].join('\n')
    }

    ensureNestDirs(ctx.paths)
    fs.writeFileSync(ctx.paths.brief(memberId), brief + '\n', 'utf8')
    fs.writeFileSync(ctx.paths.assignment(memberId), task + '\n', 'utf8')

    appendEvent({
      type: 'member_hired',
      member: memberId,
      actor: parentId,
      data: { role, tier, parent: parentId, session_id: memberId, model: routed.model, task, dispatch_mode: plan.mode, routing: routed.rationale }
    }, ctx.paths)

    if (budgetUsd !== null) {
      appendEvent({ type: 'budget_allocated', member: memberId, actor: parentId, data: { amount_usd: budgetUsd, harness_enforced: plan.budgetEnforcedByHarness } }, ctx.paths)
    }

    spawnDetached(plan.command, plan.args, { cwd: ctx.paths.root, env: { NEST_MEMBER_ID: memberId, NEST_ROOT: ctx.paths.root } })
    writeOrgCache(projectOrg(readEvents(ctx.paths)), ctx.paths)

    return [
      `hired ${role} ${memberId}`,
      `model: ${routed.model} — ${routed.rationale.join('; ')}`,
      `budget: ${budgetUsd === null ? 'uncapped' : `$${budgetUsd}`}${plan.budgetEnforcedByHarness ? ' (harness-enforced)' : ' (ledger only)'}`,
      `dispatch: ${plan.mode}${plan.mode === 'bg' ? ` — attach with \`claude attach ${memberId}\`` : ''}`,
      '',
      gate.allowed ? '' : `WARNING: forced past charter limits — ${gate.reasons.join('; ')}`
    ].filter(Boolean).join('\n')
  },

  /** Enlist a session the human already opened. */
  adopt (args) {
    const ctx = context(args)
    const charter = requireNest(ctx)
    const parentId = requireMe(ctx)
    const parent = ctx.me ?? fail(`no member ${parentId} in this Nest`)
    const sessionId = args['session-id'] ?? args._[0] ?? fail('pass the target session id')

    const role = args.role ?? 'staff'
    const tier = depthOf(ctx.org, parentId) + 1
    const task = readTask(args)

    appendEvent({
      type: 'member_adopted',
      member: sessionId,
      actor: parentId,
      data: { role, tier, parent: parentId, session_id: sessionId, model: args.model ?? null, task }
    }, ctx.paths)
    writeOrgCache(projectOrg(readEvents(ctx.paths)), ctx.paths)

    const brief = adoptionBrief({
      memberId: sessionId, role, tier, parentId, parentRole: parent.role,
      nestRoot: ctx.paths.root, model: args.model ?? 'inherited', budgetUsd: args.budget ?? null, task
    })
    fs.writeFileSync(ctx.paths.brief(sessionId), brief + '\n', 'utf8')

    return [
      `adopted ${sessionId} as ${role} (tier ${tier})`,
      '',
      'Deliver the brief below to that session now — adoption is not complete until it',
      'has been received. Use the session-messaging tool, or paste it manually.',
      '',
      '--- BEGIN BRIEF ---',
      brief,
      '--- END BRIEF ---'
    ].join('\n')
  },

  /** Post a progress signal. Cheap, and the thing that keeps the chase ladder quiet. */
  heartbeat (args) {
    const ctx = context(args)
    requireNest(ctx)
    appendEvent({ type: 'heartbeat', member: requireMe(ctx), data: { note: args.note ?? null } }, ctx.paths)
    return 'heartbeat recorded'
  },

  /** File a report and notify the supervisor. */
  report (args) {
    const ctx = context(args)
    const charter = requireNest(ctx)
    const meId = requireMe(ctx)
    const me = ctx.me
    const status = args.status ?? fail('--status is required (done|failed|blocked|progress)')
    const summary = args.summary ?? fail('--summary is required')

    const report = {
      member: meId,
      role: me?.role ?? 'unknown',
      task_id: args.task ?? 'main',
      status,
      summary,
      reason: args.reason ?? null,
      effort: args.effort ?? null,
      attempt: Number(args.attempt ?? 1),
      artifacts: args.artifacts ? String(args.artifacts).split(',').map(s => s.trim()) : [],
      reported_at: new Date().toISOString()
    }

    const file = writeReport(meId, report.task_id, report, ctx.paths)
    appendEvent({ type: 'report', member: meId, data: report }, ctx.paths)

    const lines = [`report filed: ${status}`, `written to ${file}`]

    if (me?.parent) {
      appendInbox(me.parent, {
        from: meId,
        kind: 'report',
        subject: `${me.role} ${meId.slice(0, 8)} reports ${status}`,
        body: summary,
        report_file: file
      }, ctx.paths)
      lines.push(`supervisor ${me.parent.slice(0, 8)} notified via inbox`)

      // An adopted member may have no recorded model. Falling back to the
      // charter default still yields the right instruction — "re-run this one
      // tier up" — where skipping the correction would silently strand exactly
      // the task that most needs escalating.
      const correction = correctRouting(report, me.model ?? charter.models.default, charter)
      if (correction) {
        appendEvent({ type: 'routing_correction', member: meId, data: correction }, ctx.paths)
        lines.push(`routing correction recorded: ${correction.direction} ${correction.from} -> ${correction.to} (${correction.why})`)
      }
    } else {
      lines.push('you are the Executive — report this to the human directly')
    }

    writeOrgCache(projectOrg(readEvents(ctx.paths)), ctx.paths)
    return lines.join('\n')
  },

  msg (args) {
    const ctx = context(args)
    requireNest(ctx)
    const meId = requireMe(ctx)
    const to = args.to ?? args._[0] ?? fail('pass a recipient member id')
    const body = args.body ?? args._[1] ?? fail('pass a message body')

    appendInbox(to, { from: meId, kind: args.kind ?? 'message', subject: args.subject ?? null, body }, ctx.paths)
    appendEvent({ type: 'message', member: meId, data: { to, kind: args.kind ?? 'message' } }, ctx.paths)
    return `delivered to ${to}`
  },

  inbox (args) {
    const ctx = context(args)
    requireNest(ctx)
    const messages = readInbox(requireMe(ctx), ctx.paths)
    if (args.json) return JSON.stringify(messages, null, 2)
    if (!messages.length) return 'inbox empty'

    return messages.map(m =>
      [`[${m.ts}] from ${String(m.from).slice(0, 8)} · ${m.kind}`, m.subject ? `  ${m.subject}` : '', `  ${m.body}`]
        .filter(Boolean).join('\n')
    ).join('\n\n')
  },

  /** Claim an area before editing it. */
  claim (args) {
    const ctx = context(args)
    requireNest(ctx)
    const meId = requireMe(ctx)
    const pattern = args.pattern ?? args._[0] ?? fail('pass a path pattern to claim')

    const activeOwners = new Set(
      ctx.org.members.filter(m => !TERMINAL_STATUSES.has(m.status)).map(m => m.id)
    )
    const conflicts = findConflicts(pattern, ctx.org.claims, meId, activeOwners)
    const id = claimId(pattern, meId)

    if (conflicts.length) {
      appendEvent({ type: 'claim_conflict', member: meId, data: { claim_id: id, pattern, conflicts: conflicts.map(c => c.claim_id) } }, ctx.paths)
      for (const conflict of conflicts) {
        appendInbox(conflict.owner, {
          from: meId,
          kind: 'claim_conflict',
          subject: `claim conflict on ${pattern}`,
          body: `I need to work on \`${pattern}\`, which overlaps your claim \`${conflict.pattern}\`. Reply with \`nest msg ${meId} "<proposal>"\` — propose an order, a split, or hand it over. If we cannot settle it in three exchanges, escalate.`
        }, ctx.paths)
      }
      return [
        `CONFLICT — ${pattern} overlaps ${conflicts.length} existing claim(s):`,
        ...conflicts.map(c => `  ${c.pattern} held by ${c.owner}`),
        '',
        'Each holder has been messaged. Negotiate directly:',
        ...conflicts.map(c => `  nest msg ${c.owner} "<proposal>" --me ${meId}`),
        '',
        'Do not edit these paths until the conflict is settled or your supervisor rules.'
      ].join('\n')
    }

    appendEvent({ type: 'claim_granted', member: meId, data: { claim_id: id, pattern, owner: meId, reason: args.reason ?? null } }, ctx.paths)
    return `claim granted: ${pattern} (${id})`
  },

  claims (args) {
    const ctx = context(args)
    requireNest(ctx)
    if (args.json) return JSON.stringify(ctx.org.claims, null, 2)
    if (!ctx.org.claims.length) return 'no claims'
    return ctx.org.claims
      .map(c => `${c.state.padEnd(9)} ${c.pattern} — ${String(c.owner).slice(0, 8)}${c.decision ? `\n  ruling: ${c.decision}` : ''}`)
      .join('\n')
  },

  /** A supervisor's binding decision on a contested area. */
  rule (args) {
    const ctx = context(args)
    requireNest(ctx)
    const meId = requireMe(ctx)
    const id = args.claim ?? args._[0] ?? fail('pass the claim id to rule on')
    const decision = args.decision ?? fail('--decision is required')

    const claim = ctx.org.claims.find(c => c.claim_id === id) ?? fail(`no claim ${id}`)
    appendEvent({ type: 'claim_ruled', member: claim.owner, actor: meId, data: { claim_id: id, decision, ruled_by: meId } }, ctx.paths)

    const parties = new Set([claim.owner, ...ctx.org.members.filter(m => m.parent === meId).map(m => m.id)])
    for (const party of parties) {
      appendInbox(party, { from: meId, kind: 'ruling', subject: `ruling on ${claim.pattern}`, body: decision }, ctx.paths)
    }
    return `ruled on ${id}; ${parties.size} member(s) notified`
  },

  escalate (args) {
    const ctx = context(args)
    requireNest(ctx)
    const meId = requireMe(ctx)
    const me = ctx.me ?? fail(`no member ${meId}`)
    const reason = args.reason ?? fail('--reason is required')
    if (!me.parent) return 'you are the Executive — escalate to the human, not to the Nest'

    appendInbox(me.parent, { from: meId, kind: 'escalation', subject: `escalation from ${me.role}`, body: reason }, ctx.paths)
    appendEvent({ type: 'message', member: meId, data: { to: me.parent, kind: 'escalation' } }, ctx.paths)
    return `escalated to ${me.parent}`
  },

  /** The supervisor's view: team state, and what to do about it right now. */
  status (args) {
    const ctx = context(args)
    const charter = requireNest(ctx)
    writeOrgCache(ctx.org, ctx.paths)

    const scope = args.all ? ctx.org.members : null
    const meId = args.me ?? process.env.NEST_MEMBER_ID ?? null
    const review = meId && !args.all
      ? reviewTeam(ctx.org, charter, meId)
      : ctx.org.members.map(m => ({ member: m, ...classify(m, charter) }))

    if (args.json) return JSON.stringify({ charter, org: ctx.org, review }, null, 2)

    const lines = [`Nest at ${ctx.paths.root}`, `objective: ${charter.objective ?? '(unset)'}`, '']

    if (!review.length) {
      lines.push('no members' + (meId && !args.all ? ' reporting to you' : ''))
    } else {
      lines.push(scope ? 'ALL MEMBERS' : meId && !args.all ? 'YOUR DIRECT REPORTS' : 'ALL MEMBERS')
      for (const { member, state, action, idle_minutes, why } of review) {
        lines.push(
          `  ${state.toUpperCase().padEnd(8)} ${member.role.padEnd(10)} ${member.id.slice(0, 8)} ` +
          `${(member.model ?? '-').padEnd(7)} idle:${idle_minutes}m — ${why}`
        )
      }
    }

    const todo = needsAttention(review)
    if (todo.length) {
      // The harness knows background sessions by an id it generated itself, not
      // by the one in the org chart, so a hint built from the member id would
      // hand the supervisor a command that cannot run.
      const sessions = listSessions()
      lines.push('', 'ACTION REQUIRED')
      for (const { member, action, why } of todo) {
        lines.push(`  ${action.toUpperCase()} ${member.id.slice(0, 8)} — ${why}`)
        lines.push(`    ${chaseHint(action, member, meId, harnessIdFor(member, sessions))}`)
      }
    }

    const inbox = meId ? readInbox(meId, ctx.paths) : []
    if (inbox.length) lines.push('', `INBOX: ${inbox.length} message(s) — run \`nest inbox --me ${meId}\``)

    const spentUsd = ctx.org.members.reduce((s, m) => s + m.spent_usd, 0)
    const spentTokens = ctx.org.members.reduce((s, m) => s + m.spent_tokens, 0)
    if (charter.budget.total_usd !== null || spentTokens > 0) {
      const cap = charter.budget.total_usd === null ? 'uncapped' : `of $${charter.budget.total_usd}`
      const guide = charter.budget.total_tokens ? ` of ${fmtTokens(charter.budget.total_tokens)} guide` : ''
      lines.push('', `budget: $${round(spentUsd)} ${cap} · ${fmtTokens(spentTokens)} tokens${guide}`)
    }

    return lines.join('\n')
  },

  /** Show what tier a task would route to, without hiring anyone. */
  route (args) {
    const ctx = context(args)
    const charter = requireNest(ctx)
    const decision = routeTask(signalsFrom(args), charter)
    return [
      `model: ${decision.model}`,
      `reasoning: ${decision.rationale.length ? decision.rationale.join('; ') : 'default tier, no adjustments'}`,
      `signals: ${JSON.stringify(decision.signals)}`
    ].join('\n')
  },

  fire (args) {
    const ctx = context(args)
    requireNest(ctx)
    const meId = requireMe(ctx)
    const target = args.member ?? args._[0] ?? fail('pass the member id to stop')

    const member = ctx.org.members.find(m => m.id === target)
    appendEvent({ type: 'member_stopped', member: target, actor: meId, data: { status: 'stopped', reason: args.reason ?? null } }, ctx.paths)
    writeOrgCache(projectOrg(readEvents(ctx.paths)), ctx.paths)

    const harnessId = member ? harnessIdFor(member, listSessions()) : null
    return [
      `marked ${target} stopped — its unspent budget and its claims are released`,
      harnessId
        ? `stop the process with: claude stop ${harnessId}`
        : 'no live session found for it; if one is still running, find it with: claude agents'
    ].join('\n')
  },

  ledger (args) {
    const ctx = context(args)
    const charter = requireNest(ctx)
    if (args.json) return JSON.stringify(ctx.org.members.map(pick(['id', 'role', 'budget_usd', 'spent_usd'])), null, 2)

    const rows = ctx.org.members.map(m =>
      `  ${m.role.padEnd(10)} ${m.id.slice(0, 8)} granted:$${round(m.budget_usd)} spent:$${round(m.spent_usd)} ${fmtTokens(m.spent_tokens)} tok`
    )
    const spent = ctx.org.members.reduce((s, m) => s + m.spent_usd, 0)
    const tokens = ctx.org.members.reduce((s, m) => s + m.spent_tokens, 0)

    return [
      `charter cap:  ${charter.budget.total_usd === null ? 'uncapped' : `$${charter.budget.total_usd}`}  (enforced)`,
      `token guide:  ${charter.budget.total_tokens === null ? 'none' : fmtTokens(charter.budget.total_tokens)}  (advisory — tokens are not comparable across model tiers)`,
      `reserve withheld per parent: ${charter.budget.reserve_pct}%`,
      '',
      ...rows,
      '',
      `total spent: $${round(spent)} · ${fmtTokens(tokens)} tokens`
    ].join('\n')
  },

  spend (args) {
    const ctx = context(args)
    requireNest(ctx)
    if (args.amount === undefined && args.tokens === undefined) fail('pass --amount <usd> and/or --tokens <n>')

    const amount = Number(args.amount ?? 0)
    const tokens = Number(args.tokens ?? 0)
    appendEvent({ type: 'budget_spent', member: requireMe(ctx), data: { amount_usd: amount, tokens, note: args.note ?? null } }, ctx.paths)

    return `recorded ${[amount ? `$${amount}` : null, tokens ? `${fmtTokens(tokens)} tokens` : null].filter(Boolean).join(' and ')}`
  }
}

/**
 * Fail loudly on a bad `plugin_dir` rather than at spawn time.
 *
 * A wrong path makes `claude` exit immediately, so the subordinate is recorded
 * as hired but never runs — which reads as a stalled member forty minutes
 * later, pointing nowhere near the actual mistake.
 */
function verifiedPluginDir (pluginDir) {
  if (!pluginDir) return null
  if (!fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'))) {
    fail(`charter.plugin_dir does not look like a plugin: ${pluginDir}\n  expected ${path.join(pluginDir, '.claude-plugin', 'plugin.json')}`)
  }
  return pluginDir
}

function chaseHint (action, member, meId, harnessId = null) {
  const me = meId ? ` --me ${meId}` : ''
  const live = harnessId ?? `<session-id>   # not running; find it with: claude agents`

  switch (action) {
    case 'nudge':
      return `nest msg ${member.id} "status check: what are you working on, and what is your ETA?" --kind nudge${me}`
    case 'inspect':
      return `claude logs ${live}   # then judge: progressing, looping, or blocked?`
    case 'reassign':
      return `claude stop ${live} && nest fire ${member.id}${me}   # then re-hire, one tier up if it failed on capability`
    default:
      return ''
  }
}

function buildCharterFrom (args) {
  const charter = {}
  if (args.objective) charter.objective = args.objective

  const limits = pickDefined({ max_members: num(args['max-members']), max_depth: num(args['max-depth']), max_concurrent: num(args['max-concurrent']) })
  if (Object.keys(limits).length) charter.limits = limits

  const budget = pickDefined({
    total_usd: args.budget === 'none' ? null : num(args.budget),
    total_tokens: args.tokens === 'none' ? null : num(args.tokens),
    reserve_pct: num(args['reserve-pct'])
  })
  if (Object.keys(budget).length) charter.budget = budget

  const models = pickDefined({
    roster: args.models ? String(args.models).split(',').map(s => s.trim()) : undefined,
    ladder: args.ladder ? String(args.ladder).split(',').map(s => s.trim()) : undefined,
    ceiling: args.ceiling,
    floor: args.floor,
    default: args['default-model']
  })
  if (Object.keys(models).length) charter.models = models

  const unattended = pickDefined({ enabled: bool(args.unattended), interval_minutes: num(args.interval) })
  if (Object.keys(unattended).length) charter.unattended = unattended

  if (args.isolation) charter.isolation = args.isolation
  if (args['plugin-dir']) charter.plugin_dir = path.resolve(args['plugin-dir'])

  // A roster without an explicit ceiling should not silently keep the default
  // ceiling, which may name a model the user does not actually have.
  if (charter.models?.roster && !charter.models.ceiling) {
    const ladder = charter.models.ladder ?? DEFAULT_CHARTER.models.ladder
    charter.models.ceiling = [...charter.models.roster].sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b)).at(-1)
    charter.models.floor = [...charter.models.roster].sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b))[0]
    if (!charter.models.roster.includes(DEFAULT_CHARTER.models.default)) {
      charter.models.default = charter.models.ceiling
    }
  }

  return charter
}

function signalsFrom (args) {
  return {
    mechanical: bool(args.mechanical) ?? false,
    specified: bool(args.specified) ?? false,
    scope: args.scope,
    ambiguity: args.ambiguity,
    risk: args.risk,
    unknown_root_cause: bool(args['unknown-root-cause']) ?? false,
    prior_failures: num(args['prior-failures']) ?? 0
  }
}

function readTask (args) {
  if (args['task-file']) return fs.readFileSync(path.resolve(args['task-file']), 'utf8')
  return args.task ?? args._[0] ?? fail('pass --task "<assignment>" or --task-file <path>')
}

function renderCharter (charter) {
  return [
    'CHARTER',
    `  objective:   ${charter.objective ?? '(unset)'}`,
    `  headcount:   max ${charter.limits.max_members} members, depth ${charter.limits.max_depth}, ${charter.limits.max_concurrent} concurrent`,
    `  budget:      ${charter.budget.total_usd === null ? 'uncapped' : `$${charter.budget.total_usd}`} enforced (${charter.budget.reserve_pct}% reserve per parent)`,
    `  tokens:      ${charter.budget.total_tokens === null ? 'not tracked against a guide' : `${fmtTokens(charter.budget.total_tokens)} advisory`}`,
    `  models:      roster [${charter.models.roster.join(', ')}] · floor ${charter.models.floor} · default ${charter.models.default} · ceiling ${charter.models.ceiling}`,
    `  sla:         quiet ${charter.sla.quiet_minutes}m · stall ${charter.sla.stall_minutes}m · lost ${charter.sla.lost_minutes}m · ${charter.sla.max_nudges} nudges`,
    `  unattended:  ${charter.unattended.enabled ? `every ${charter.unattended.interval_minutes}m` : 'off'}`,
    `  isolation:   ${charter.isolation}`,
    `  always ask:  ${charter.escalation.always_ask.join(', ')}`
  ].join('\n')
}

export function fmtTokens (n) {
  const value = Number(n ?? 0)
  if (value >= 1e6) return `${round(value / 1e6)}M`
  if (value >= 1e3) return `${round(value / 1e3)}k`
  return String(value)
}

const num = v => (v === undefined || v === null || v === '' ? undefined : Number(v))
const bool = v => (v === undefined ? undefined : v === true || v === 'true' || v === '1' || v === 'yes')
const round = n => Math.round(n * 100) / 100
const pick = keys => obj => Object.fromEntries(keys.map(k => [k, obj[k]]))
const pickDefined = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))

export { NestError }
