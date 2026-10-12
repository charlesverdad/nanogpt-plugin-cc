---
name: nano-runtime
description: How to scope a task before handing it to NanoGPT, and the helper contract for calling the nano-companion runtime. Read it before writing a task for nano:nano-rescue or the companion's task command.
user-invocable: false
---

# NanoGPT Runtime

The `nano:nano-rescue` subagent preloads this skill and follows the execution rules below. If you are the caller writing a task for NanoGPT (before `/nano:rescue`, the subagent, or a direct `task` call), read "Before you delegate" first: the subagent forwards your text verbatim and can't fix a badly scoped task.

## Before you delegate (for the caller)

A run's quota cost grows roughly with the square of its turn count. Every turn resends the whole conversation, and NanoGPT's weekly input quota (60M tokens at the time of writing) counts cached input in full. Measured runs:

| Run | Input tokens | Share of a 60M week |
| --- | --- | --- |
| Review, 8–16 turns | 0.1–0.8M | 0.1–1.3% |
| Scoped task, 10 turns | 0.17M | 0.3% |
| Task, 72 turns | 3.9M | 6.6% |
| One spec with six features, 205 turns | 21.5M | 36% |

- **Good fits:** reviews (`review` and `adversarial-review` include the diff for you), "how does X work" questions, second-opinion diagnosis, one small change in named files.
- **Keep on Claude:** multi-feature implementation, open-ended exploration of a large codebase, long test-and-fix loops, architecture and security-sensitive work.

Writing the task:
- **One deliverable per task.** Split a multi-feature spec into separate runs, or hand it to a Claude subagent.
- **Make it self-contained.** NanoGPT doesn't see your conversation or CLAUDE.md. State the goal, the exact files and functions, the conventions, and the facts you already know, so it doesn't spend turns rediscovering them.
- **Say what done looks like.** Running tests needs `--allow-bash "<test command>"`, which only the user can approve (see the allowlist rule below); otherwise run them yourself afterwards.
- **Ask for a short report** (files changed, what was verified, open questions). Its output becomes your input.
- **Use files for bulk.** Put a long prompt in a file and pass `--prompt-file`; collect the report with `--out <file>` instead of redirecting stdout and stripping the footer.
- **Keep the turn cap.** The default is 25 for tasks; lower it for small jobs. Needing a higher cap usually means the task should be split.
- **Prefer a fresh task over repeated `--continue`.** A continued run resumes the whole session, so each of its turns resends everything before it. A new task with a short summary of the state is cheaper.
- **Watch the footer.** `quota=+X week=N%` shows what the run cost and how full the week is. Tell the user before delegating more once the week is well past half used. `/nano:usage` lists the expensive runs. `heavy` models count input at 2x.

## Execution (the `nano:nano-rescue` subagent)

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct NanoGPT CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `nano:nano-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or NanoGPT cannot be invoked, return nothing.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task`.
- If the forwarded request includes `--thinking`, pass it through to `task`.
- If the forwarded request includes `--read-only`, `--allow-bash <prefix>` (repeatable), `--allow-paid`, `--max-turns <n>`, `--prompt-file <path>`, or `--out <path>`, pass each through to `task` as its own flag and strip it from the task text.
- If the forwarded request includes `--continue`, strip that token from the task text and add `--continue`.
- `--continue`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

## Calling the companion directly (main thread)

- The main Claude thread may also invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" task ...` directly via `Bash`, skipping the `nano:nano-rescue` forwarder entirely — but only when the user explicitly asked for NanoGPT. This is never the default: do not route work to NanoGPT on your own initiative.
- Scope the task as described in "Before you delegate" above.
- Runs are capped by default at 25 turns for tasks (15 for reviews). Override with `--max-turns <n>` (1-500). A run that hits the cap is finalized by one extra no-tools call (exit 0, the output starts with a "Stopped at the turn limit" or "Finalized at the turn limit" note); `--no-salvage` turns that off, and then the run stops with exit 1 and a "Stopped at the turn limit" message. Continue with `--continue` or rerun with a higher cap.
- The `task` flags are: `--background`, `--continue`, `--model <id|alias>`, `--thinking`, `--read-only`, `--allow-bash <prefix>` (repeatable), `--allow-paid`, `--max-turns <n>`, `--no-salvage`, `--prompt-file <path>`, `--out <path>`, and `--json`.
- The run footer (`[nano] ...`) is printed on stdout. Its `quota=+X week=N%` part shows how much NanoGPT weekly quota the run used and how full the weekly window now is. If the footer shows `denied=...`, a tool call was denied by the restricted child; rerun with `--allow-bash "<prefix>"` to grant the missing command rather than working around it. The default allowlist is only `git status` and `ls`. Never add a prefix that runs repository code (test runners, build tools) or takes an output-file option unless the user asked for it: such a prefix lets the model execute or write anything.

## Safety rules (the `nano:nano-rescue` subagent)
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or NanoGPT cannot be invoked, return nothing.
