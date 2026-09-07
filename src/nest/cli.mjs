import { commands, NestError } from './commands.mjs'

const HELP = `nest — hierarchical multi-session orchestration for Claude Code

USAGE
  nest <command> [options]

Every command needs to know who is running it. Pass --me <member-id>, or export
NEST_MEMBER_ID (spawned subordinates get it set automatically).

SETUP
  init                      Create the Nest, write the Charter, register the Executive
    --objective <text>        what "done" means
    --budget <usd|none>       total spend cap — the only cap actually enforced
    --tokens <n|none>         advisory token guide, reported but never enforced
                              (tokens are not comparable across model tiers)
    --max-members <n>         headcount cap            (default 8)
    --max-depth <n>           how deep the org may go  (default 3)
    --max-concurrent <n>      simultaneous members     (default 4)
    --models <a,b,c>          models you actually have access to
    --ceiling <model>         highest tier anyone may use
    --unattended <true|false> may the Executive work while you are away
    --plugin-dir <path>       only when running from a clone: forwarded to every
                              subordinate so it inherits the hooks and skills
  charter [show|set]        Show or amend the Charter

TEAM
  hire                      Spawn a new subordinate session
    --task <text> | --task-file <path>
    --role <manager|staff>    default: manager at tier 1, staff below
    --model <model>           skip routing and force a tier
    --budget <usd>            defaults to everything you may allocate
    --mode <bg|batch>         bg: attachable · batch: harness-enforced budget
    --worktree [name]         isolate this member in its own git worktree
    --dry-run                 print the command without running it
  adopt <session-id>        Enlist a session the human already opened
  fire <member-id>          Mark a member stopped

ROUTING
  route [signals]           Show which model a task would route to
    --mechanical --specified --unknown-root-cause
    --scope <single-file|module|cross-cutting>
    --ambiguity <none|some|high>   --risk <low|medium|high|irreversible>
    --prior-failures <n>

PROTOCOL
  status                    Team state and what to do about it now
  whoami                    Your role, supervisor and assignment
  heartbeat --note <text>   Signal that you are still working
  report --status <done|failed|blocked|progress> --summary <text>
    --reason beyond_capability    triggers escalation to a higher tier
    --effort trivial              triggers de-escalation of similar tasks
  inbox                     Read messages addressed to you
  msg <member-id> <text>    Message a peer or supervisor
  escalate --reason <text>  Hand a problem to your supervisor

AREAS
  claim <path-glob>         Claim ground before editing it
  claims                    List claims and rulings
  rule <claim-id> --decision <text>   Supervisor's binding ruling

BUDGET
  ledger                    Who was granted what, and what they spent
  spend --amount <usd>      Record spend against your allocation
    --tokens <n>              record tokens too, for visibility

Add --json to status, inbox, claims and ledger for machine-readable output.`

export function parseArgs (argv) {
  const args = { _: [] }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }

    const [flag, inlineValue] = splitOnce(token.slice(2), '=')
    if (inlineValue !== undefined) {
      args[flag] = inlineValue
      continue
    }

    const next = argv[i + 1]
    // A flag followed by another flag, or by nothing, is a boolean.
    if (next === undefined || next.startsWith('--')) {
      args[flag] = true
    } else {
      args[flag] = next
      i++
    }
  }

  return args
}

function splitOnce (text, separator) {
  const index = text.indexOf(separator)
  return index === -1 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)]
}

export function run (argv = process.argv.slice(2)) {
  const [name, ...rest] = argv

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    return { ok: true, output: HELP }
  }
  if (name === '--version' || name === '-v') {
    return { ok: true, output: 'nest 0.1.0' }
  }

  const command = commands[name]
  if (!command) {
    return { ok: false, output: `unknown command: ${name}\n\nRun \`nest help\` for the command list.` }
  }

  try {
    return { ok: true, output: command(parseArgs(rest)) }
  } catch (error) {
    if (error instanceof NestError) return { ok: false, output: `nest: ${error.message}` }
    throw error
  }
}

export { HELP }
