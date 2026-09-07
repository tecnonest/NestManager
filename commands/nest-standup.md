---
description: Run a standup across the whole Nest — collect every report, surface blockers and stalls, and summarise the engagement's real state
---

Run a standup across the entire hierarchy.

1. `nest status --all --json` — the full org chart, every tier.
2. `nest inbox` — anything addressed to you.
3. `nest claims` — contested areas and outstanding rulings.
4. `nest ledger` — budget granted and spent.

Then produce a summary for the human with four sections:

**Done** — workstreams that reported complete. Say whether you *verified* them
or are relaying a claim; "reported done" and "done" are different states.

**In flight** — who is working on what, and how long since each was last heard
from.

**Stuck** — every BLOCKED, STALLED and LOST member, what it was doing, and what
you are doing about it. This is the section the human actually needs: it is the
only information they cannot get by looking at the result.

**Decisions needed** — anything waiting on the human, with enough context to
decide without opening another session.

Close with budget spent against the Charter total, and flag any limit you are
close to hitting before it stops you rather than after.
