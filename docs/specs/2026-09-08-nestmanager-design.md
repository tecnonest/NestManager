# NestManager — Design Specification

**Date:** 2026-09-08
**Status:** Approved
**License:** MIT

## 1. Problem

Claude Code users routinely run several sessions at once. Today the only way to
coordinate them is to tell one session "go manage that other session." That
breaks down in three specific ways:

1. **Subordinate sessions do not report.** A session told to "let me know when
   you're done" frequently doesn't. The instruction lives in the model's
   context, and context gets compacted, exhausted, or simply out-prioritised by
   the task itself.
2. **Supervising sessions cannot observe.** A Claude Code session only executes
   while its user turn is running. Between turns it is inert. Even a
   subordinate that *does* report has nobody awake to receive the report.
3. **There is no structure.** Two sessions editing the same repository clobber
   each other. Nobody owns integration. Nobody notices a stalled session.

NestManager makes multi-session work behave like an organisation: an explicit
chain of command, a written engagement contract, mechanically guaranteed
reporting, and active follow-up on subordinates that go quiet.

## 2. Non-goals

- Cross-machine or cloud orchestration. Everything is local to one machine.
- Replacing the `Agent` (subagent) tool for short in-context fan-out. Nest is
  for long-lived, observable, attachable sessions.
- A general workflow engine. Control flow is decided by the models, not scripted.

## 3. Roles

Roles are **positional**, not fixed. Depth is set by the Charter.

| Tier | Role | Responsibility |
|------|------|----------------|
| T0 | **Executive** | The session the human talks to. Owns the Charter. Sole human interface. |
| T1 | **Manager** | Owns a workstream. Decomposes, delegates, arbitrates conflicts, integrates results. |
| T2 | **Staff** | Performs the work. |
| T3+ | *promoted Staff* | A Staff member that hires its own team becomes a Manager for that subtree, if the Charter allows the depth. |

Every member has exactly one parent (except the Executive) and reports only to
that parent. Escalation travels one hop at a time.

## 4. The Nest — shared state

All coordination state lives in `.nest/` under the project root and is
**gitignored**. Session IDs, cost data and transcript excerpts are
machine-specific; committing them creates noise and merge conflicts.

```
.nest/
  charter.json            # the engagement contract
  org.json                # derived org chart (never hand-written)
  inbox/<member-id>.jsonl # append-only message queue for that member
  reports/<member-id>/<task-id>.json
  claims/<claim-id>.json  # area ownership decisions
  log/events.jsonl        # append-only audit trail — the source of truth
```

### 4.1 Concurrency model

Up to a dozen OS processes write here simultaneously. The design avoids locks
entirely:

- **`log/events.jsonl` is the only source of truth.** Every state change is a
  single-line append. Line-sized appends are atomic at the OS level, so
  concurrent writers cannot interleave or lose records.
- **`org.json` is a derived projection.** It is rebuilt from the event log on
  read. It is a cache, never authoritative. If it disagrees with the log, the
  log wins.
- **`inbox/*.jsonl` are per-recipient**, so there is exactly one consumer and
  many producers — again append-only.

This means a crashed or force-killed session can never corrupt the Nest. Worst
case it leaves a stale `status: working` record, which the stall detector
(§6.3) is designed to catch.

## 5. Charter — the engagement contract

When the Executive receives a job, it conducts **one** structured intake round
with the human, then operates autonomously inside the resulting envelope. It
returns to the human only when a Charter boundary is reached.

`charter.json`:

```json
{
  "objective": "string — what done looks like",
  "limits": {
    "max_members": 8,
    "max_depth": 3,
    "max_concurrent": 4
  },
  "budget": { "total_usd": 20.0, "total_tokens": 2000000, "reserve_pct": 20 },
  "models": {
    "roster": ["fable", "opus", "sonnet", "haiku"],
    "ceiling": "opus",
    "floor": "haiku"
  },
  "escalation": {
    "always_ask": ["destructive_ops", "external_comms", "budget_overrun", "scope_change"],
    "never_ask": ["model_choice", "task_split", "hiring_within_limits"]
  },
  "unattended": { "enabled": true, "interval_minutes": 15 },
  "isolation": "auto"
}
```

`isolation` is one of `auto` (worktree for write tasks, shared checkout for
read-only tasks), `always` (worktree for every write task), or `never`
(coordination only, per §8).

### 5.1 Budget chaining

A parent may only delegate from its own remaining allocation. Delegation is
enforced twice: logically in the Nest ledger, and technically by passing
`--max-budget-usd` to the spawned process. A subtree therefore cannot exceed
its parent's grant even if a model misbehaves.

`reserve_pct` is held back by each parent so it can afford to re-run a failed
task at a higher model tier (§7.2). A member that finishes or is stopped ties up
only what it actually spent; the remainder of its grant returns to the parent,
which stops a long engagement from slowly starving itself.

### 5.2 Why dollars and not tokens

Both are recorded. Only dollars gate anything.

Tokens are the more intuitive unit for a subscription user, who never sees a
per-call price, and the decision was reconsidered on exactly that ground. Two
things settle it the other way:

- **Only dollars are enforceable.** `--max-budget-usd` is a limit the harness
  itself applies. A token ceiling is a number in a JSON file that nothing is
  obliged to respect.
- **Only dollars are comparable across tiers.** The same million tokens differ
  in cost by roughly an order of magnitude between the floor and ceiling model.
  A token budget therefore cannot bound a hierarchy whose entire purpose is
  mixing tiers: a manager could stay comfortably inside it while multiplying the
  actual bill.

`budget.total_tokens` exists as an advisory gauge — reported by `nest ledger`
and `nest status`, never used to refuse a hire — because the number is still
worth seeing even when it cannot be the constraint.

## 6. Reporting — three independent guarantees

No single mechanism is trusted. Each layer covers a distinct failure mode.

### 6.1 Write guarantee — the Stop hook

A `Stop` hook ships with the plugin in `hooks/hooks.json`, so it is active in
every session that has the plugin enabled. It appends a report record to the
Nest and a notification to the parent's inbox, and no-ops entirely in sessions
that are not Nest members.

This is the central reliability decision:

- The hook is executed by the harness, not by the model. A model that "forgets"
  to report is irrelevant — reporting is not the model's job.
- Because it is registered once by the plugin rather than injected per-spawn, it
  covers **adopted** sessions the human opened manually just as well as spawned
  ones. Both are equally observable, which is what makes adoption viable at all.

The handler is registered in exec form (`"command": "node"` with `args`) rather
than as a shell string. Shell form on Windows requires Git Bash to be installed
and resolvable, and the hook would simply not run without it; exec form spawns
`node` directly, which exists wherever Claude Code does, and removes argument
quoting from the picture entirely.

Two guards keep the hook from becoming noise:

- It ignores stops where `stop_hook_active` is set, since that stop is only
  happening because some hook blocked the previous one.
- An automatic report leaves the member in a non-terminal state, so it declines
  to file again while its own last report is still the newest event for that
  member. Repeating an alarm buries the alarms that matter.

### 6.2 Wake — push

After writing the report the hook attempts to wake the parent: an OS
notification, plus (when the parent is an attended session) a
`ccd_session_mgmt.send_message` injection. This channel is explicitly *best
effort* — the tool is unavailable in unattended sessions — which is why it is
never the only mechanism.

### 6.3 Chase — pull

Every parent runs `nest status` at the start of each turn and on each
unattended tick. It compares each subordinate's `last_heartbeat` against its
SLA and escalates through a fixed ladder:

| Step | Action |
|------|--------|
| 1 | **Nudge** — post a status request to the subordinate's inbox |
| 2 | **Inspect** — read the subordinate's recent output (`claude logs <id>`) and judge whether it is progressing, looping, or blocked |
| 3 | **Escalate** — report the stall to *its own* parent, with the evidence gathered in step 2 |
| 4 | **Reassign** — stop the session, return the task to the queue, re-dispatch (optionally one model tier up) |

Step 2 is what makes the ladder useful: distinguishing "slow but working" from
"stuck in a loop" requires reading the work, not just the clock.

## 7. Model routing

### 7.1 Routing rubric

A Manager selects a model before dispatching, using task signals rather than
guesswork:

| Signal | Tier |
|--------|------|
| Mechanical, fully specified, single file, run-and-collect | **floor** (haiku) |
| Standard implementation, plan exists, established pattern to follow | **sonnet** |
| Ambiguous requirements, unknown root cause, architecture, security, cross-cutting change | **opus** |
| Final review, irreversible decision, conflicting expert opinions | **ceiling** |

The roster and ceiling come from the Charter, so the policy adapts to the
user's subscription and cost tolerance rather than being hardcoded.

### 7.2 Two-way correction

Static routing is guesswork; the system corrects itself from observed outcomes.

- **Escalate:** a subordinate that fails twice, or reports
  `blocked: beyond_capability`, causes the task to be re-dispatched one tier
  higher. Funded from the parent's reserve.
- **De-escalate:** a task that completes well under its expected effort is
  logged as over-provisioned, and comparable tasks route one tier lower.

Both directions are recorded in `log/events.jsonl` as `routing_correction`
events, so the rationale is auditable.

## 8. Conflict resolution

Peers coordinate directly; the Manager arbitrates only when they fail.

1. **Claim.** Before writing, a Staff member calls `nest claim <path-glob>`.
2. **Negotiate.** On collision, both parties receive each other's member IDs
   and negotiate over `nest msg <peer-id>`.
3. **Escalate.** If unresolved after three exchanges, or after two minutes of
   no reply from the peer, both escalate to their Manager.
4. **Rule.** The Manager issues a binding decision — serialise, split, or
   reassign — persisted to `claims/` as an authoritative record.

Technical isolation (git worktrees) is available per task but not mandatory;
the Charter's `isolation` preference decides. Coordination is the primary
mechanism, isolation the fallback.

## 9. Hiring

Two paths, one registry.

**Spawn** — create a new session:

```
claude --bg \
  --session-id <uuid>              # assigned by the parent, not discovered
  --model <routed-tier> \
  --max-budget-usd <allocation> \
  --append-system-prompt <role-brief> \
  -p <assignment>
```

Pre-assigning the session ID is what makes the org chart deterministic: the
parent records the identity before the child exists, so there is no window in
which a subordinate is running but unregistered.

**Adopt** — enlist a session the human already opened: record it in the Nest
and deliver the role brief via `send_message`. The project-level Stop hook
(§6.1) gives it the same reporting guarantees as a spawned member.

## 10. Deliverable

Distributed as a Claude Code **plugin** — a plain skill cannot install hooks,
and the Stop hook is load-bearing.

```
NestManager/
  .claude-plugin/plugin.json
  skills/     nest-executive, nest-manager, nest-staff, nest-protocol
  hooks/      stop-report.mjs, session-start-identity.mjs
  commands/   nest-start, nest-status, nest-report, nest-standup
  bin/nest.mjs   dependency-free Node CLI for all registry operations
  docs/  README.md  LICENSE
```

The CLI has no third-party dependencies: it runs wherever Claude Code runs, and
the hooks must work before any install step could have run.

## 11. Failure modes and responses

| Failure | Response |
|---------|----------|
| Subordinate crashes mid-task | Stale `working` record; stall ladder (§6.3) detects and reassigns |
| Subordinate exhausts context | Stop hook still fires; report records partial progress |
| Parent dies | Event log survives; a new Executive rebuilds `org.json` and resumes |
| `send_message` unavailable | Inbox file still written; pull path unaffected |
| Runaway hiring | `max_members`, `max_depth`, `max_concurrent` plus chained `--max-budget-usd` |
| Two members claim one file | Negotiate → arbitrate (§8) |
| Model over/under-provisioned | Routing correction (§7.2) |

## 12. Testing strategy

- **CLI unit tests** — event log append/projection, budget arithmetic, claim
  collision detection, stall classification. Pure functions over fixtures; no
  Claude processes required.
- **Hook integration tests** — invoke the hook with recorded payloads, assert
  the resulting Nest state.
- **Protocol simulation** — a fake "session" harness that appends events
  without spawning real sessions, to exercise the chase ladder and escalation
  paths deterministically.
- **End-to-end smoke test** — one Executive, two Staff, one deliberately
  stalled, asserting the stall is detected and reassigned.
