---
name: nano-runtime
description: Internal helper contract for calling the nano-companion runtime from Claude Code
user-invocable: false
---

# NanoGPT Runtime

Use this skill only inside the `nano:nano-rescue` subagent.

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
- If the forwarded request includes `--read-only`, `--allow-bash <prefix>` (repeatable), or `--allow-paid`, pass each through to `task` as its own flag and strip it from the task text.
- If the forwarded request includes `--continue`, strip that token from the task text and add `--continue`.
- `--continue`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Calling the companion directly:

- The main Claude thread may also invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" task ...` directly via `Bash`, skipping the `nano:nano-rescue` forwarder entirely, when it wants the cheapest path. This avoids the subagent hop.
- The `task` flags are: `--background`, `--continue`, `--model <id|alias>`, `--thinking`, `--read-only`, `--allow-bash <prefix>` (repeatable), `--allow-paid`, and `--json`.
- The run footer (`[nano] ...`) is printed on stdout. If the footer shows `denied=...`, a tool call was denied by the restricted child; rerun with `--allow-bash "<prefix>"` to grant the missing command rather than working around it.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or NanoGPT cannot be invoked, return nothing.
