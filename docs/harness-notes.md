# Harness behaviour notes

Facts about Claude Code that NestManager depends on, each one established by
running a real session rather than by reading documentation. They are recorded
here because every one of them was a surprise, and because anything built on
Claude Code will meet the same walls.

Verified against Claude Code 2.1.261 on Windows, 2026-09.

## `--session-id` is not honoured for background sessions

Passing `--session-id <uuid>` together with `--bg` does not give the background
session that id. It generates its own.

This breaks the obvious identity design — "the parent assigns the id, so the org
chart is written before the child exists" — in a way that fails *silently*. The
Nest recorded one id, the harness used another, and the Stop hook looked up the
harness id, found no matching member, and filed nothing. The one mechanism whose
entire job is guaranteeing a report was the thing that quietly did nothing.

**What we do instead:** the parent passes its assigned id through the
`NEST_MEMBER_ID` environment variable, and hooks treat that as authoritative,
falling back to `session_id` only when it is absent.

## Background sessions have nobody to answer a permission prompt

A `--bg` session with no attached human blocks forever on the first tool call
that needs approval. `--permission-mode acceptEdits` covers file edits but not
shell commands, so a subordinate whose protocol is expressed as CLI calls
deadlocks on its very first instruction.

From the supervisor's side this is indistinguishable from a stalled member. The
subordinate is in fact following its brief exactly, waiting for an approval that
cannot arrive.

**What we do instead:** every spawn pre-authorises the Nest CLI with
`--allowedTools`. Both shell tools are listed, because which one a model reaches
for is platform-dependent — PowerShell on Windows, Bash elsewhere.

## `--allowedTools` is variadic and will eat your prompt

`--allowedTools <tools...>` keeps consuming arguments past a boolean flag. This:

```
claude --allowedTools "Bash(node:*)" --bg "<the prompt>"
```

starts a session with **no prompt at all** — it reports `idle — send a prompt to
start` and waits for input that never comes. The variadic stops only at an
option that takes a value of its own, so this works:

```
claude --allowedTools "Bash(node:*)" --model haiku --bg "<the prompt>"
```

**What we do instead:** the rules are emitted first, immediately before
`--session-id`, so correct behaviour does not depend on argument order elsewhere
in the command.

## Background sessions want a worktree before editing

A `--bg` session asked to edit files announces "I need to enter a worktree for
this background session before making edits" and tries to create one. In a
repository with no commits this fails (`Failed to resolve base branch "HEAD"`),
and the session then tries to `git commit` — which needs approval nobody can
give.

**Implication:** a repository that background subordinates will work in needs at
least one commit. Worktree isolation is closer to a default than an option, so
the Charter's `isolation` setting describes something the harness already leans
toward rather than an invention of ours.

## `--max-budget-usd` only applies in print mode

Documented, but worth stating plainly: the flag is ignored under `--bg`. A
budget passed to an attachable session is enforced by the Nest ledger and
nothing else.

This is why `nest hire` reports which kind of cap a member actually got, rather
than implying a guarantee that is not there.

## `--append-system-prompt-file` exists but is undocumented

It does not appear in `claude --help`, but it is a registered option — probing
it returns `option '--append-system-prompt-file <file>' argument missing` rather
than an unknown-option error.

It matters because a role brief is ~30 lines containing quotes and newlines, and
passing that inline breaks three separate ways on Windows: cmd.exe cannot carry
newlines in an argument, quote escaping differs across shells, and command lines
cap at roughly 8191 characters.

## Plugin hooks use exec form or they need Git Bash

In `hooks/hooks.json`, a handler given as a single shell string is run through a
shell — on Windows, Git Bash, which must be installed and resolvable or the hook
does not run. Exec form avoids the shell entirely:

```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"] }
```

`node` is a real executable on every platform, and each argument is passed as
one argv entry, so paths with spaces need no quoting.

## `--plugin-dir` does not reach spawned sessions

Running a plugin from a clone with `--plugin-dir` applies to that session only.
Sessions it spawns start without the plugin — no hooks, no role skills — and
therefore ignore a protocol they were never given.

**What we do instead:** `charter.plugin_dir` is forwarded to every subordinate.
An installed plugin needs no such setting, which is why installing properly is
the recommended path.
