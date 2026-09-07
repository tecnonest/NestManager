---
name: nest-protocol
description: Shared NestManager protocol reference: the command surface, the reporting contract, escalation rules and model-tier routing. Loaded by the executive, manager and staff role skills; read it when any nest command or protocol rule is unclear.
---

# NestManager protocol

Every member of a Nest — Executive, Manager or Staff — follows the same
protocol. Your role decides *what* you decide; this file decides *how* you
communicate.

## The one rule that matters

**Reporting is not optional and not a courtesy.** A supervisor that hears
nothing assumes you have stalled and will reassign your work to someone else.
Silence is not neutral — it is a signal, and it is the wrong one.

## Your identity

Every command needs to know who is running it:

```bash
nest whoami --me <your-member-id>
```

Spawned members get `NEST_MEMBER_ID` set automatically, so `--me` is optional.
Adopted members must pass `--me` explicitly, or export it once per session. Your
member id is stated in your role brief; if you cannot find it, run `nest status`
and identify yourself before doing anything else.

## Every turn, in this order

1. `nest inbox` — messages arrive here and nowhere else. Nothing pushes them
   into your context; if you do not read the inbox, you have not received them.
2. `nest status` — if you supervise anyone, this tells you who needs action now.
3. Do the work.
4. `nest heartbeat --note "<what you are doing>"` before any long step.
5. `nest report` when the assignment reaches a terminal state.

## Reporting

```bash
nest report --status done     --summary "<what you produced>" --artifacts "path,path"
nest report --status progress --summary "<what is finished, what remains>"
nest report --status blocked  --reason <why> --summary "<what you need>"
nest report --status failed   --summary "<what went wrong>" --attempt 2
```

Two report fields change what your supervisor does next:

| Field | Effect |
|-------|--------|
| `--reason beyond_capability` | Your supervisor re-runs the task one model tier up |
| `--effort trivial` | Comparable tasks route one tier *down* in future |

`beyond_capability` is a normal, expected outcome, not an admission of failure.
Reporting it is strictly better than producing plausible work you are not
confident in — a wrong answer costs the retry *plus* whatever it broke.

## Claiming ground before you edit

```bash
nest claim "src/auth/**" --reason "rewriting the token validator"
```

If the claim is granted, the area is yours. If it collides, you are given the
other member's id and you negotiate with them directly:

```bash
nest msg <peer-id> "I need session.mjs for ~20 minutes. Take token.mjs first and I'll rebase?"
```

Settle it yourselves. If three exchanges do not converge, or the peer has been
silent for two minutes, stop negotiating and escalate:

```bash
nest escalate --reason "<peer-id> and I both need src/auth/session.mjs and cannot agree an order"
```

Your supervisor then issues a binding ruling. Follow it without re-litigating.

## Escalation

Escalate one hop, to your own supervisor, never past them. Escalate when:

- You are blocked on a decision that is not yours to make
- The assignment conflicts with something another member is doing
- You have discovered the task is materially different from how it was described
- You are about to do something on the Charter's `always_ask` list

Do not escalate to ask permission for work you were already assigned.

## Model tiers

Model selection is your supervisor's decision, made from declared task signals:

| Signals | Tier |
|---------|------|
| Mechanical, fully specified, single file | floor (cheapest) |
| Standard implementation, plan exists, pattern to follow | middle |
| Ambiguous requirements, unknown root cause, architecture, security, cross-cutting | high |
| Final review, irreversible decision, conflicting expert opinions | ceiling |

Preview a routing decision without hiring anyone:

```bash
nest route --ambiguity high --unknown-root-cause --scope cross-cutting
```

The ceiling is set by the human in the Charter. Never work around it — if the
task genuinely needs more than the ceiling allows, that is an escalation to the
human, not a decision to make quietly.

## Command reference

| Command | Purpose |
|---------|---------|
| `nest status` | Team state and required actions |
| `nest whoami` | Your role, supervisor, assignment |
| `nest inbox` | Read your messages |
| `nest msg <id> <text>` | Message a peer or supervisor |
| `nest heartbeat --note <text>` | Signal you are still working |
| `nest report --status <s> --summary <t>` | File a report |
| `nest escalate --reason <text>` | Hand a problem upward |
| `nest claim <glob>` | Claim an area before editing |
| `nest claims` | List claims and rulings |
| `nest hire --task <text>` | Spawn a subordinate (supervisors only) |
| `nest adopt <session-id>` | Enlist an existing session |
| `nest rule <claim-id> --decision <text>` | Rule on a contested area |
| `nest ledger` | Budget granted and spent |
| `nest fire <id>` | Mark a member stopped |

Add `--json` to `status`, `inbox`, `claims` and `ledger` for machine-readable
output.
