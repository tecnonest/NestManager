---
description: Show the Nest org chart, flag members that have gone quiet or blocked, and act on whatever needs attention
argument-hint: [--all to include members outside your team]
---

Check on the hierarchy and act on it.

1. Run `nest inbox` and read every message. Nothing delivers them into your
   context automatically.
2. Run `nest status $ARGUMENTS`.
3. Work the ACTION REQUIRED block. It prints the exact command for each case;
   it is not advisory.

Priority order, most urgent first:

- **BLOCKED** — the member has stopped and is waiting on a decision only you can
  make. A clock-based check rates it healthy because it just spoke, which is
  exactly backwards. Deal with it first. If the reason is
  `beyond_capability`, re-dispatch the task one model tier up.
- **LOST** — past the lost threshold. Stop it and reassign the work.
- **STALLED** — silent with nudges exhausted. Run `claude logs <id>` and judge
  whether it is progressing, looping, or blocked. A long tool call and an
  infinite loop look identical from outside; read the output before deciding.
- **QUIET** — worth one cheap nudge.

Then report to the human: what changed since last time, what is in flight, what
needs their decision. Be specific about what is *not* progressing — that is the
information they cannot get any other way.
