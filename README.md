# NestManager

Hierarchical multi-session orchestration for [Claude Code](https://claude.com/claude-code).

Run Claude Code sessions as an organisation — an Executive that talks to you,
Managers that own workstreams, and Staff that do the work — with reporting that
does not depend on a model remembering to report.

> Status: early, but exercised against live sessions. A real background
> subordinate has run the whole loop unattended — read its brief, claimed
> ground, hit a conflict, messaged its peer, escalated when that didn't settle
> it, and filed a `blocked` report that reached its supervisor's inbox and
> surfaced as the top item in `nest status`. Interfaces may still change.

## The problem

If you run several Claude Code sessions at once, you have probably tried telling
one of them to go manage the others. It breaks in three specific ways:

1. **Subordinates don't report.** "Let me know when you're done" lives in the
   model's context, and context gets compacted, exhausted, or crowded out by the
   task itself.
2. **Supervisors can't observe.** A session only executes while a turn is
   running. Between turns it is inert — so even a subordinate that *does* report
   has nobody awake to receive it.
3. **There's no structure.** Two sessions edit the same file and clobber each
   other. Nobody owns integration. Nobody notices a session that quietly died.

NestManager addresses all three, and treats the third one — noticing — as the
part that actually matters.

## How it works

### State lives in files, not in context

Everything coordinating the hierarchy is in `.nest/` (gitignored):

```
.nest/
  charter.json            # the engagement contract
  org.json                # derived org chart — a cache, never authoritative
  inbox/<member>.jsonl    # append-only message queue
  reports/<member>/*.json # structured reports
  claims/                 # area ownership and rulings
  log/events.jsonl        # append-only audit trail — the source of truth
```

Every state change is a single appended line, which is atomic at the OS level.
A dozen sessions can write concurrently with no locking, and a session that is
force-killed cannot corrupt anything — worst case it leaves a stale `working`
record, which is precisely what stall detection is built to catch.

### Reporting has three independent guarantees

| Layer | Mechanism | Failure it covers |
|-------|-----------|-------------------|
| **Write** | A `Stop` hook files the report | The model forgetting — reporting isn't the model's job |
| **Wake** | Report notifies the supervisor's inbox | The supervisor being idle between turns |
| **Chase** | Supervisors classify every subordinate each turn | The subordinate crashing, looping, or dying silently |

The hook ships with the plugin rather than being injected per-session, so it
covers sessions *you* opened by hand just as well as ones the Nest spawned —
which is what makes adopting an existing session worth doing. It stays silent in
any session that isn't a Nest member.

When a subordinate stops without reporting, the supervisor is handed that
session's **last message**, not just a pointer to a transcript — so "it went
quiet" arrives with the content that explains why.

### Going quiet is not the only failure

The chase ladder escalates with silence — nudge, then read the transcript, then
stop and reassign. But the state that matters most is one no clock can see:

**A member that reports `blocked` has just spoken, so every silence-based check
rates it healthy — while it sits waiting for a decision it cannot make.**
NestManager treats `blocked` as the highest-priority state there is.

## Model routing

Managers pick a model from declared task signals, bounded by a ceiling *you* set:

| Signals | Tier |
|---------|------|
| Mechanical, fully specified, single file | floor |
| Standard implementation, pattern to follow | middle |
| Ambiguous, unknown root cause, cross-cutting, security | high |
| Final review, irreversible decision | ceiling |

```bash
nest route --ambiguity high --unknown-root-cause --scope cross-cutting
# model: opus
# reasoning: +1 requirements are ambiguous; +1 root cause is unknown; +1 change cuts across modules
```

It corrects itself in both directions. A subordinate reporting
`blocked --reason beyond_capability` gets its task re-run one tier up; a task
finishing with `--effort trivial` routes comparable work one tier down.

When the ideal tier isn't on your roster, routing rounds **up**. The two ways of
being wrong aren't symmetric: over-provisioning wastes money that de-escalation
reclaims, while under-provisioning produces wrong work and costs the money
anyway on the retry.

## Conflicts

Peers coordinate; supervisors arbitrate only when they fail.

```bash
nest claim "src/auth/**"          # granted
nest claim "src/auth/session.mjs" # CONFLICT — you're given the holder's id
nest msg <peer> "take token.mjs first and I'll rebase?"
nest escalate --reason "..."      # after 3 exchanges or 2 minutes of silence
```

The supervisor then issues a binding ruling — an order, a split, or a single
owner — recorded and delivered to everyone affected.

## Install

Requires Node 18+ and Claude Code.

```bash
git clone https://github.com/tecnonest/NestManager.git
cd NestManager && npm link
```

`npm link` puts `nest` on your PATH. It is optional — briefs fall back to an
absolute `node` invocation — but it makes every command in the docs work as
written.

Then enable the plugin. **Installing it properly is the path that works**,
because an installed plugin is active in every session, including the ones the
Nest spawns.

Running from a clone with `--plugin-dir` applies to *that session only*, so its
subordinates start with no hooks and no role skills — they ignore a protocol
they were never handed, and it fails silently. If you are working from a clone,
tell the Charter where the plugin lives so it forwards the flag to every
subordinate:

```bash
nest init --objective "..." --plugin-dir /path/to/NestManager
```

## Quick start

Ask the Executive to take a job:

```
/nest-start Refactor the auth module and get the test suite green
```

It runs a short intake round — objective, headcount, budget, model ceiling, what
must always come back to you, whether it may work while you're away — writes the
Charter, and then operates autonomously inside it.

Check on it any time:

```
/nest-status
```

Or drive it directly:

```bash
nest init --objective "Ship the auth refactor" --budget 20 --models "haiku,sonnet,opus"
nest hire --role manager --task "Rewrite the token validator" --ambiguity high
nest status
```

## The Charter

One negotiated contract, then autonomy inside it. The Executive returns to you
only when a boundary is reached.

```json
{
  "objective": "Ship the auth refactor",
  "limits": { "max_members": 8, "max_depth": 3, "max_concurrent": 4 },
  "budget": { "total_usd": 20.0, "total_tokens": 2000000, "reserve_pct": 20 },
  "models": { "roster": ["haiku", "sonnet", "opus"], "ceiling": "opus", "floor": "haiku" },
  "escalation": { "always_ask": ["destructive_ops", "external_comms", "budget_overrun", "scope_change"] },
  "unattended": { "enabled": true, "interval_minutes": 15 }
}
```

Budget is **chained**: a parent may only grant from its own remaining
allocation, and each parent withholds a reserve so it can afford to re-run a
failed task at a higher tier. A subtree cannot outspend its parent's grant. A
member that finishes or is stopped releases what it never spent.

**Dollars are the cap; tokens are a gauge.** Both are recorded, but only dollars
gate anything, for two reasons. `--max-budget-usd` is the only limit the harness
itself will apply — a token ceiling is a number nobody is obliged to respect.
And tokens are not comparable across tiers: the same million tokens differ in
cost by an order of magnitude between the floor and the ceiling model, so a
token budget cannot bound a hierarchy whose whole purpose is mixing tiers. A
manager could stay inside it while multiplying the bill tenfold.

## Commands

| | |
|---|---|
| `nest init` | Create the Nest and write the Charter |
| `nest hire --task <text>` | Spawn a subordinate session |
| `nest adopt <session-id>` | Enlist a session you already have open |
| `nest status` | Team state and required actions |
| `nest report --status <s> --summary <t>` | File a report |
| `nest heartbeat --note <text>` | Signal you're still working |
| `nest inbox` / `nest msg <id> <text>` | Read and send messages |
| `nest claim <glob>` / `nest rule <id> --decision <t>` | Claim ground, rule on conflicts |
| `nest escalate --reason <text>` | Hand a problem upward |
| `nest route [signals]` | Preview a model routing decision |
| `nest ledger` | Budget granted and spent |

Run `nest help` for the full surface.

## Design notes

The full specification is in
[`docs/specs`](docs/specs/2026-09-08-nestmanager-design.md), including the
concurrency model, the failure table, and why each decision was made.

[`docs/harness-notes.md`](docs/harness-notes.md) records the Claude Code
behaviours this depends on — each one found by running a real session, not by
reading documentation. Among them: `--session-id` is ignored for background
sessions, `--allowedTools` is variadic and will silently eat your prompt, and a
background session has nobody to answer a permission prompt. Useful to anyone
building on Claude Code, not just to this project.

Two implementation details worth knowing:

- **Role briefs and assignments are passed as files**, never as inline
  arguments. A ~30-line brief containing quotes and newlines breaks in three
  separate ways on Windows: cmd.exe can't carry newlines in an argument, quote
  escaping differs across shells, and command lines cap at ~8191 characters.
- **`--max-budget-usd` only works in print mode**, so `nest hire --mode bg`
  (attachable sessions) enforces budget through the ledger, while
  `--mode batch` gets a hard, harness-enforced cap but isn't attachable. Neither
  is strictly better; the CLI reports which one you got.

## Development

```bash
npm test          # 34 tests, no dependencies, no sessions spawned
```

Routing, stall classification, budget arithmetic and claim collision are pure
functions over fixtures, so the whole protocol is testable without launching a
single Claude session.

## Licence

MIT — see [LICENSE](LICENSE).

Built by [TecnoNest](https://tecnonest.com). Contributions and issues welcome.
