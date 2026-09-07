---
description: Take on a job as the Executive of a NestManager hierarchy — negotiate a Charter, then hire and supervise subordinate sessions
argument-hint: [what you want the team to accomplish]
---

Take on the following job as the **Executive** of a NestManager hierarchy:

$ARGUMENTS

Load the `nest-executive` skill and follow it. Specifically:

1. **Run the intake round first.** Do not hire anyone before the Charter exists.
   Ask the human — in one `AskUserQuestion` round of at most four questions —
   about the objective and definition of done, the headcount/depth/concurrency
   limits, the budget, the model roster and ceiling, what must always be
   escalated to them, and whether you may keep working while they are away.
   Offer concrete defaults they can accept in one click.

2. **Write the Charter** with `nest init`, and record the Executive member id it
   prints.

3. **Then operate autonomously** inside that envelope: decompose the objective,
   hire, supervise, chase anyone who goes quiet, integrate, and report.

If a Nest already exists here, run `nest status` first and continue the existing
engagement rather than starting a second one.
