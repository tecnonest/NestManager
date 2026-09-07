import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/**
 * How a subordinate should invoke the CLI.
 *
 * The role brief instructs members to run `nest ...`, but that only resolves if
 * the package was linked globally. When it was not, every protocol instruction
 * in the brief would fail silently — the member would look like it was ignoring
 * the protocol when it simply had no way to follow it. Falling back to an
 * absolute `node <path>` invocation makes the brief correct either way.
 */
export function resolveNestCommand () {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['nest'], { stdio: 'ignore' })
    return 'nest'
  } catch {
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'nest.mjs')
    return `node "${cli}"`
  }
}

/**
 * Turning a hiring decision into a `claude` invocation.
 *
 * Two dispatch modes exist because the CLI forces a genuine trade-off:
 *
 *   bg    — `claude --bg`. The subordinate is a real, attachable session. The
 *           human can open it, watch it, and take over. Budget is enforced by
 *           the Nest ledger only.
 *   batch — `claude -p`. Accepts `--max-budget-usd`, which the CLI documents as
 *           print-mode only, so the spend cap is enforced by the harness itself
 *           and cannot be talked around. The cost is that the session is not
 *           attachable and the human cannot watch it work.
 *
 * Neither is strictly better: pick `bg` for work the human may want to join,
 * `batch` for work that must not be able to overspend.
 */

export const DISPATCH_MODES = Object.freeze(['bg', 'batch'])

/**
 * Pre-authorise the Nest CLI for a subordinate.
 *
 * Without this the whole protocol deadlocks on its first step. A background
 * subordinate has no human attached, so the permission prompt raised by its
 * very first `nest inbox` call is never answered — and from the supervisor's
 * side that is indistinguishable from a stalled session. The member is in fact
 * following its brief perfectly and waiting for an approval that cannot arrive.
 *
 * Both shell tools are covered because the tool a model reaches for is
 * platform-dependent: PowerShell on Windows, Bash elsewhere.
 */
export function nestPermissionRules (nestCommand = resolveNestCommand()) {
  const executable = nestCommand === 'nest' ? 'nest' : 'node'
  return [`Bash(${executable}:*)`, `PowerShell(${executable}:*)`]
}

export function newMemberId () {
  return crypto.randomUUID()
}

/**
 * Both the role brief and the assignment are passed as *files*, never as inline
 * arguments.
 *
 * The brief is ~30 lines containing quotes and backticks. Inlining it would
 * break in three separate ways: cmd.exe cannot carry newlines in an argument,
 * quote escaping differs between Windows and POSIX shells, and Windows caps a
 * command line at ~8191 characters. Passing a path sidesteps all three, and the
 * positional prompt shrinks to a single line that points at the assignment file.
 */
export function buildSpawnArgs ({
  sessionId = newMemberId(),
  model,
  budgetUsd = null,
  briefFile,
  assignmentFile,
  displayName = null,
  worktree = null,
  permissionMode = null,
  mode = 'bg',
  addDirs = [],
  pluginDir = null,
  allowedTools = nestPermissionRules()
}) {
  if (!DISPATCH_MODES.includes(mode)) throw new Error(`unknown dispatch mode: ${mode}`)
  if (!briefFile) throw new Error('briefFile is required — a subordinate must know who it reports to')
  if (!assignmentFile) throw new Error('assignmentFile is required')

  // --allowedTools is variadic, and it only stops consuming at an option that
  // takes a value of its own: placed before a boolean flag it swallows the
  // positional prompt, and the session starts idle waiting for input that never
  // comes. Emitting it first, immediately before --session-id, makes that
  // impossible by construction rather than by argument-order luck.
  const args = []
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','))

  args.push('--session-id', sessionId, '--append-system-prompt-file', briefFile)

  if (model) args.push('--model', model)
  if (displayName) args.push('--name', displayName)
  if (permissionMode) args.push('--permission-mode', permissionMode)
  if (worktree) args.push('--worktree', worktree)
  // A subordinate without the plugin gets neither the Stop hook nor its role
  // skill, so it would ignore a protocol it was never handed.
  if (pluginDir) args.push('--plugin-dir', pluginDir)
  for (const dir of addDirs) args.push('--add-dir', dir)

  if (mode === 'batch') {
    args.push('--print', '--output-format', 'json')
    // Documented as print-mode only, so it is silently ineffective under --bg.
    // Attaching it here rather than unconditionally keeps the guarantee honest.
    if (budgetUsd !== null) args.push('--max-budget-usd', String(budgetUsd))
  } else {
    args.push('--bg')
  }

  args.push(`Read your assignment at ${assignmentFile} and carry it out, following the NestManager protocol in your system prompt.`)

  return { command: 'claude', args, sessionId, mode, budgetEnforcedByHarness: mode === 'batch' && budgetUsd !== null }
}

/**
 * The role brief injected into a subordinate's system prompt.
 *
 * This is the single most important string in the project: it is the only place
 * a subordinate learns its own identity, its chain of command, and the fact
 * that reporting is mandatory. It is written to survive compaction — short,
 * concrete, and free of anything the model must infer.
 */
export function roleBrief ({ memberId, role, tier, parentId, parentRole, nestRoot, model, budgetUsd, task, nest = resolveNestCommand() }) {
  const budgetLine = budgetUsd === null
    ? 'Budget: uncapped by the Charter.'
    : `Budget: $${budgetUsd} for this assignment. Report before exhausting it.`

  return [
    `# NestManager role: ${role} (tier ${tier})`,
    '',
    `You are a member of a NestManager hierarchy, not a standalone session.`,
    '',
    `- Your member id: ${memberId}`,
    `- You report to: ${parentRole} (${parentId})`,
    `- Nest root: ${nestRoot}`,
    `- Model assigned: ${model}`,
    `- ${budgetLine}`,
    '',
    '## Your assignment',
    '',
    task,
    '',
    '## Mandatory protocol',
    '',
    `Run the Nest CLI as \`${nest}\`. Every command below uses it verbatim.`,
    '',
    `1. Run \`${nest} inbox --me ${memberId}\` at the start of every turn. Messages from`,
    '   your supervisor and peers arrive there, and they are not delivered any other way.',
    `2. Run \`${nest} heartbeat --me ${memberId} --note "<what you are doing>"\` whenever you`,
    '   begin a long step. A supervisor that hears nothing will assume you have stalled',
    '   and reassign your work.',
    `3. Before editing files, run \`${nest} claim --me ${memberId} "<path-glob>"\`. If the claim`,
    '   collides, negotiate directly with the peer named in the response using',
    `   \`${nest} msg <peer-id> "<text>" --me ${memberId}\`. If three exchanges do not settle it,`,
    `   run \`${nest} escalate --me ${memberId} --reason "<summary>"\` and wait for a ruling.`,
    `4. Finish with \`${nest} report --me ${memberId} --status done|failed|blocked --summary "<result>"\`.`,
    '',
    'If the work turns out to need judgement beyond what this model tier can give,',
    `report \`--status blocked --reason beyond_capability\` rather than guessing. Your`,
    'supervisor will re-run the task at a higher tier; that is a normal, expected',
    'outcome and not a failure on your part.',
    '',
    'Never hire subordinates of your own unless your supervisor explicitly delegated',
    'that authority in your assignment.'
  ].join('\n')
}

/** The message delivered to an existing session when it is adopted rather than spawned. */
export function adoptionBrief (context) {
  return [
    '# You have been enlisted into a NestManager hierarchy',
    '',
    'Adopt the role below for the remainder of this work. It supersedes any prior',
    'understanding of who you report to.',
    '',
    roleBrief(context)
  ].join('\n')
}
