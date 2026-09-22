# Changelog

## 0.1.0

- Forked from `kimi-plugin-cc` to run tasks and code reviews on NanoGPT subscription models from inside Claude Code.
- Runtime: spawns Claude Code itself headless (`claude -p --restricted ...`) against NanoGPT's Anthropic-compatible endpoint, with `read` and `write` permission profiles and an explicit tool allowlist.
- Model aliases (`default`, `heavy`, `alt`, `fast`) and a subscription guard that refuses pay-per-token models unless `--allow-paid` is passed. Catalog is fetched from NanoGPT and cached for 24h.
- Background task execution with stream-json progress, session id capture for resume, `/nano:status`, `/nano:result`, and `/nano:cancel`.
- `--continue` resumes the latest NanoGPT task for the current Claude session from the stored Claude session id.
- Setup checks: Node and `claude` versions, CLI contract, keychain/environment API key, a live ping, subscription quota, and the review-gate state.
- API key is resolved fresh from the OS keychain (macOS `security` / Linux `secret-tool`) or `NANOGPT_API_KEY`; never written to job files, logs, or output.
- Live tests (`tests/live.test.mjs`, skipped unless `NANOGPT_LIVE=1`) covering the permission boundary, resume, review, setup, background flow, and cancel.
- `nano:nano-rescue` agent prompt hardened to be AgentShield-clean: prompt-injection boundaries, no key disclosure, no output manipulation, single-call rate limit.
- Security: the default Bash allowlist is `git status` and `ls`. `git diff`/`git log`/`git show` were dropped because `--output=<file>` let the model write anywhere, including `.git/config`. An offline regression test drives the real `claude` against a fake endpoint (`NANO_REAL_CLAUDE=1`), and the README documents that any allowlisted command that runs repo code lets the model execute anything.
- Security: the background worker rebuilds permissions from the profile name and Bash allowlist and never trusts a stored profile object; `CLAUDE_CODE_SUBAGENT_MODEL` is stripped from the child env; the fallback data dir (no `CLAUDE_PLUGIN_DATA`) is per-user (`$TMPDIR/nano-companion-<uid>`, mode 0700).
- Fixes: `--continue` skips stop-gate review jobs; a run that dies after reporting its session keeps the session id; `setup --disallow-bash` removes every prefix given; a lone non-result JSON object is not treated as a result; prompts go through stdin above 64 KiB (bytes) and always on Windows, including the stop gate's prompt; stdin is read with an EAGAIN-safe loop so large piped prompts don't fail.
- Turn caps: `task`, `review`, and `adversarial-review` accept `--max-turns <n>` (1-500), defaulting to 25 for tasks and 15 for reviews (the stop gate always uses 15). A run that hits the cap is rendered as its own outcome (`stopReason: "max_turns"`, exit 1, "Stopped at the turn limit (n turns)...") rather than a generic failure or missing-result error, and `task --continue` can resume a job that stopped there. `--continue` never carries a previous run's cap forward. The hidden `--max-turns` flag (absent from `claude --help`) is verified by execution (`verifyHiddenFlags`) in `check-cli-contract.mjs`, after the help-based checks.
- Quota reporting: a NanoGPT weekly-usage snapshot is taken just before and just after every run with a resolved key (tasks, background jobs, reviews, and the stop gate). The run footer, JSON payload, job record, and metrics log (`runs.jsonl`, as `quotaDelta`) get a `quota` object showing the change in weekly usage and how full the weekly window now is (`quota=+1.2M week=24%`); a failed or slow usage fetch never fails the run, and the footer omits the parts it can't compute.
- `nano-rescue` and the `nano-runtime` skill no longer describe themselves as proactive or free: the rescue subagent now runs only when the user explicitly asks to hand work to NanoGPT, and the docs replace "cost $0 per call" with the fact that subscription calls are included but still count against the weekly input-token quota (cached input in full).
- The stop-time review gate's `/nano:setup` next-steps no longer suggest enabling it; `setup.md` and the README describe it as opt-in and note that it spends quota on every session stop while it is on.

Earlier versions (as kimi-plugin-cc):

## 1.0.1

- Added a test suite covering the shared library and runtime integration (fake Kimi CLI).
- Added a version-bump script.
- Added a Kimi CLI version-compatibility check with CI.
- Relicensed under the MIT License, retaining upstream Apache-2.0 attribution for codex-plugin-cc (see NOTICE / LICENSE-APACHE).

## 1.0.0

- Initial version of the Kimi plugin for Claude Code
