# Handover: nanogpt-plugin-cc

Turn this repo, currently a verbatim clone of `kimi-plugin-cc` v1.0.1 with its git history, into a Claude Code plugin that delegates **tasks and reviews to NanoGPT subscription models**. The plugin runs Claude Code itself headless against NanoGPT's Anthropic-compatible endpoint.

- Repo: https://github.com/charlesverdad/nanogpt-plugin-cc (public). `origin` is this repo; `upstream` is `charlesverdad/kimi-plugin-cc`.
- Written 2026-09-22 against Claude Code **2.1.278** and kimi-plugin-cc **v1.0.1**.
- Everything under "Verified facts" was tested live. Anything marked **VERIFY** was not tested.
- Before starting, read `CLAUDE.md` in this repo. It explains how to use `bin/nano-agent` to hand work to NanoGPT while you implement. Please use it and log the experience; that is part of the deliverable.

---

## 1. Why this exists

The user has a NanoGPT subscription with about 60M tokens/week on open-weight models (GLM, DeepSeek, Qwen, MiniMax, Kimi…). Calls to subscription-included models cost $0. The goal is to push well-scoped work off Claude onto those models from inside Claude Code, with the same UX as `/kimi:rescue` and `/kimi:review`.

A plugin subagent can't run on a non-Anthropic model in-process: subagents share the parent's API endpoint. So, as with the kimi plugin, the pattern is a thin forwarding subagent plus a companion script that spawns an external agent CLI. Here that CLI is `claude` itself, pointed at NanoGPT.

**Non-goals:** image/video/scraping tools from the NanoGPT MCP; supporting pay-per-token models by default; Windows (keep whatever works, but don't invest).

---

## 2. Verified facts (runtime contract)

| Fact | Detail |
|---|---|
| Endpoint | `ANTHROPIC_BASE_URL=https://nano-gpt.com/api`. Claude Code appends `/v1/messages`. NanoGPT's own docs say `https://nano-gpt.com/api/v1`; **that returns an empty response**, so don't use it. |
| Auth | `ANTHROPIC_API_KEY=<nanogpt key>` (sent as `x-api-key`). `Authorization: Bearer` also works at the HTTP level. |
| Cost | Subscription-included models report `usage.cost: 0` on the raw `/v1/messages` response even with a $0 account balance. `anthropic/*` and `openai/*` models are **not** included (pay-per-token). |
| Quota multipliers | `z-ai/glm-5.3`, `deepseek/deepseek-v4-pro(-0813)`, `moonshotai/kimi-k2.7-code`, `z-ai/glm-5(.1)`, `deepseek-latest`, `glm-latest` count input at **2×**. Most others are 1×. |
| Model metadata | NanoGPT's model list (detailed) returns per model `subscription: {included, inputTokenMultiplier}`, `context_length`, `capabilities.{tool_calling,reasoning}`, `pricing`. Seen via the NanoGPT MCP; the REST route is probably `GET https://nano-gpt.com/api/v1/models?detailed=true` (**VERIFY** with curl). Docs also mention `GET /api/subscription/v1/models?detailed=true`. |
| Tool calling | Works through the Anthropic translation layer. Tested on `z-ai/glm-5.2`, `z-ai/glm-5.3-flash`, `qwen/qwen3.8-27b`, `minimax/minimax-m3`. GLM-5.2 was fastest (≈20s for a 4-turn read task) and used the fewest tokens. |
| Nesting | Running `claude -p` from inside a Claude Code Bash tool works. |
| Model-name noise | Claude Code prints `[claude-code:unrecognized_model] {...}` and `⚠ claude.ai connectors are disabled…` on stderr. Both are harmless; filter them. |
| Cost field | Claude Code's `total_cost_usd` is a made-up estimate for these models. Ignore it and trust NanoGPT's `usage.cost`. |
| Transcripts | Each headless run writes `~/.claude/projects/<cwd-slug>/<session>.jsonl` unless `--no-session-persistence` is passed. Keep persistence, because resume needs it. |

### Headless invocation that works (see `bin/nano-agent`)

```bash
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
  ANTHROPIC_BASE_URL=https://nano-gpt.com/api ANTHROPIC_API_KEY="$KEY" API_TIMEOUT_MS=600000 \
  ANTHROPIC_DEFAULT_OPUS_MODEL="$M" ANTHROPIC_DEFAULT_SONNET_MODEL="$M" ANTHROPIC_DEFAULT_HAIKU_MODEL="$M" \
  claude --restricted --strict-mcp-config -p "$PROMPT" --model "$M" \
    --tools="Read,Glob,Grep[,Edit,Write][,Bash]" \
    --permission-mode dontAsk --allowedTools="<allow rules>" \
    --output-format json [--resume <session_id>] </dev/null
```

### Flag gotchas (each one cost a debugging round)

1. **`--allowedTools` and `--tools` are variadic.** `--allowedTools "Read" "my prompt"` swallows the prompt as a tool name, and then `-p` errors with "Input must be provided". Always use the `--flag=value` form.
2. **Don't use `--bare`.** It sets `CLAUDE_CODE_SIMPLE=1`, which cuts the toolset to Bash/Read/Edit **regardless of `--tools`**: no Glob, Grep or Write.
3. **`--restricted` is the security boundary.** It ignores user/project/local settings files (so none of the user's hooks, plugins or permission rules apply), removes code-running tools unless `--tools` names them, confines file tools to the working directories, refuses `bypassPermissions`, and blocks writes to settings, git and tool-config files. The runs above also showed no CLAUDE.md or memory content loaded.
4. **`--strict-mcp-config`** with no `--mcp-config` means no MCP servers are loaded.
5. **`--permission-mode dontAsk`** auto-denies anything not in `--allowedTools`. Denials come back in `permission_denials[]`.
6. **Don't use `--permission-mode auto` in the child.** Its safety check then runs on the NanoGPT model, fails to produce verdicts, and fails closed. It blocked even `python3 -c 'print(6*7)'`, and spent about 20 checker calls at ~30k tokens each on it.
7. **Resume works.** `--resume <session_id>` from the **same cwd** keeps context and returns the same `session_id`.

### Permission boundary test (all results as expected)

Setup: `--tools=Read,Glob,Grep,Edit,Write,Bash` with `--allowedTools=Read,Glob,Grep,Edit(./**),Write(./**),Bash(python3:*)`.

| Attempt | Result |
|---|---|
| Write `inside.txt` (in cwd) | ✅ allowed |
| Write `../escaped.txt` | ❌ denied |
| `python3 -c …` (allowlisted) | ✅ allowed |
| `touch touched.txt` (not allowlisted) | ❌ denied |
| `printf hi > ../redirect-out.txt` | ❌ denied |
| Edit `.git/config` | ❌ denied |
| Read-only profile: any Bash/Edit/Write attempt (5 of them) | ❌ all denied |

Note: shell redirects that write *inside* cwd (`printf hi > x.txt`) are allowed when an `Edit(./**)` rule exists. Redirect targets are checked against Edit rules.

### JSON result fields observed (`--output-format json`)

`type`, `is_error`, `result` (final text), `session_id`, `num_turns`, `duration_ms`, `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`, `permission_denials[].{tool_name,tool_input}`, `modelUsage`, `total_cost_usd` (ignore). **VERIFY** `subtype` values for max-turns and error cases.

---

## 3. Target shape

| Item | Kimi (now) | NanoGPT fork |
|---|---|---|
| Plugin name | `kimi` | `nano` (commands `/nano:rescue`, `/nano:review`, …). A short name is nicer to type; the user can veto. |
| Marketplace name | `moonshotai-kimi` | `nanogpt-plugin-cc` |
| Install | `/plugin install kimi@moonshotai-kimi` | `/plugin install nano@nanogpt-plugin-cc` |
| Plugin dir | `plugins/kimi/` | `plugins/nano/` (use `git mv` to keep history) |
| Companion | `scripts/kimi-companion.mjs` | `scripts/nano-companion.mjs` |
| Runtime lib | `scripts/lib/kimi.mjs` | `scripts/lib/runtime.mjs` (env, args, key, JSON parsing) |
| Model catalog | none | `scripts/lib/models.mjs` (aliases, subscription check, cache) |
| Session env | `KIMI_COMPANION_SESSION_ID` | `NANO_COMPANION_SESSION_ID` |
| State fallback dir | `$TMPDIR/kimi-companion` | `$TMPDIR/nano-companion` |
| Agent | `kimi-rescue` (`model: sonnet`) | `nano-rescue` (`model: haiku`) |
| Skills | `kimi-cli-runtime`, `kimi-result-handling` | `nano-runtime`, `nano-result-handling` |
| CLI contract | `kimi --help` tokens | `claude --help` tokens: `--restricted`, `--strict-mcp-config`, `--tools`, `--permission-mode` (+ `dontAsk` choice), `--allowedTools`, `--output-format`, `--resume`, `--model`, `-p` |
| CI compat workflow | `kimi-cli-compat.yml` (PyPI matrix) | `claude-cli-compat.yml`: `npm i -g @anthropic-ai/claude-code@<ver>` over a small version matrix plus `latest`, then run `check-cli-contract.mjs` |
| package.json name | `@moonshotai/kimi-plugin-cc` | `nanogpt-plugin-cc`, version `0.1.0` |

Keep the MIT `LICENSE`, `LICENSE-APACHE` and `NOTICE`. Add a line to `NOTICE`: "Forked from kimi-plugin-cc (MIT), itself derived from codex-plugin-cc (Apache-2.0)."

---

## 4. Runtime spec: `scripts/lib/runtime.mjs`

Most of this section is **new code, not a port**. Kimi's `buildKimiArgs({cwd, model, thinking, continueSession, prompt})` always emits `--quiet --yolo`. It has no profiles, JSON parsing, truncation or key handling. Only the job, state and render plumbing around it carries over.

### 4.1 API key

Resolve the key in this order:
1. `process.env.NANOGPT_API_KEY`
2. macOS: `security find-generic-password -s nanogpt-api-key -w`
3. Linux: `secret-tool lookup service nanogpt-api-key` (best effort)

Rules:
- **Never** write the key to job files, logs, rendered output or error messages.
- The background worker reads `request` from the job JSON. Make sure the key isn't in `request`. Resolve it fresh inside the worker.
- Add a test that runs a fake job and greps the state dir for the fake key.

### 4.2 Child env

Start from `process.env`.
- **Delete:** `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`.
- **Set:** `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `API_TIMEOUT_MS=600000`, and `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL=<model>`, so that no background call can route to a paid Claude model.
- Allow `NANOGPT_BASE_URL` to override the base URL (useful for tests).

### 4.3 Permission profiles

Build these as a pure function so they're easy to unit-test.

| Profile | Used by | `--tools` | `--allowedTools` |
|---|---|---|---|
| `read` | `review`, `adversarial-review`, stop gate, `task --read-only` | `Read,Glob,Grep` | `Read,Glob,Grep` |
| `write` | `task` (rescue default) | `Read,Glob,Grep,Edit,Write,Bash` | `Read,Glob,Grep,Edit(./**),Write(./**)` + `Bash(<prefix>:*)` for each entry in the Bash allowlist |

- **Default Bash allowlist:** `git status`, `git diff`, `git log`, `git show`, `ls`.
- **Extending it:**
  - per workspace via `setup --allow-bash "<prefix>"` (stored in state `config.bashAllow`), and removed with `--disallow-bash`;
  - per run via `task --allow-bash "<prefix>"` (repeatable).
- If the final allowlist has no Bash entries, drop `Bash` from `--tools` entirely.
- **VERIFY** that compound commands (`git diff && rm -rf x`, `$(…)`, pipes) get denied with prefix rules. Write a live test for it.

This is a deliberate change from kimi. There, `review` and the stop gate run with `--yolo`, even though the README calls review read-only. Here, review is genuinely read-only.

### 4.4 Args

Export `buildClaudeArgs({prompt, model, profile, resumeSessionId, outputFormat})`. It returns the argv shown in §2, uses `=` for the variadic flags, and puts `-p <prompt>` before other flags.

Spawn with `stdio: ["ignore", "pipe", "pipe"]`; stdin must not be a pipe or `claude` waits 3s for it.

### 4.5 Output and progress

- **Foreground:** use `--output-format json` and parse the single JSON object.
- **Background:** use `--output-format stream-json --verbose` (**VERIFY** that `--verbose` is required with `-p`). Append a short progress line to the job log for each tool use, e.g. `Read plugins/x.mjs`, `Bash git diff`. The final `{"type":"result",…}` event has the same fields as the json format.
- **Rendered task output:**
  - the `result` text, capped at `NANO_MAX_INLINE_CHARS` (default 8000); if cut, end with `… truncated, full output: /nano:result <job-id>`;
  - then a footer line in the same shape as `bin/nano-agent`: model, turns, tokens, seconds, session id, and denied tool calls if any.
- The denial list matters: it tells the calling Claude to rerun with `--allow-bash`.
- **Job record:** store the full `result`, `session_id` (as `claudeSessionId`), `usage`, `permission_denials`, `model` and `profile`.

### 4.6 Continue / resume

`task --continue`:
1. Use the existing `task-resume-candidate` logic to find the newest finished task job for this Claude session.
2. Pass `--resume <claudeSessionId>` and spawn in that job's cwd.
3. Carry over its model and profile unless they're overridden.

If there's no candidate, error clearly.

### 4.7 Metrics log

Append one JSON line per run to `${CLAUDE_PLUGIN_DATA:-$TMPDIR/nano-companion}/runs.jsonl`, using the same fields as `bin/nano-agent`'s log. That keeps the plugin and wrapper comparable.

---

## 5. Models: `scripts/lib/models.mjs`

- **Aliases:**
  - `default` → `z-ai/glm-5.2`
  - `heavy` → `z-ai/glm-5.3` (2×)
  - `alt` → `minimax/minimax-m3`
  - `fast` → `z-ai/glm-5.3-flash`
  - Workspace default is overridable via `setup --model <id|alias>` (stored in `config.model`).
- **`--thinking`:** use `<model>:thinking` when that id exists in the catalog; otherwise warn and run the base model.
- **Catalog:**
  - fetch the detailed model list (§2);
  - cache it 24h in plugin data;
  - if the fetch fails, fall back to a small built-in allowlist of the models above.
- **Guard:** refuse a model where `subscription.included !== true` unless `--allow-paid` is passed. The error should name 2–3 included alternatives.
- **Warnings:** print a one-line warning when `inputTokenMultiplier > 1`.

---

## 6. Commands, agent, skills, hooks

- **Commands:** port all seven (`setup`, `review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`): `kimi` → `nano`, Kimi → NanoGPT. Keep the argument grammar and add:
  - `rescue`/`task`: `--read-only`, `--allow-bash <prefix>` (repeatable), `--allow-paid`. `--model` also accepts aliases.
  - `setup`: `--model <id|alias>`, `--allow-bash <prefix>`, `--disallow-bash <prefix>`, and the existing review-gate toggles.
- **`nano-rescue` agent:**
  - `model: haiku`, `tools: Bash`, same forwarding rules;
  - strip `--read-only`, `--allow-bash`, `--allow-paid` from the task text but forward them as flags;
  - its description should make Claude reach for it proactively for well-scoped exploration, boilerplate, test scaffolding and mechanical refactors, but keep architecture, security-sensitive work and final review on Claude.
- **`nano-runtime` skill:** also document that the main thread may call `node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" task …` directly via Bash, skipping the forwarder, when it wants the cheapest path.
- **`nano-result-handling` skill:** port it; keep the "never auto-apply review fixes" rule.
- **Stop-review gate hook:** port it. The gate must use the `read` profile and must never run a write-capable task.
- **Session lifecycle hook:** port it with the env var rename.

### `setup` checks, in order

Report each check; `ready` is true only if all pass.

1. Node version is at least 18.18.
2. `claude` is on PATH and `claude --version` is ≥ 2.1.278.
3. The CLI contract passes.
4. An API key resolves (print the source, never the value).
5. A live ping: `POST {base}/v1/messages` on the default model with `max_tokens: 16`. Pass if the response includes `usage.cost == 0` (the subscription is active).
6. Report the review-gate state.

If the key is missing, print exactly:

```
security add-generic-password -a "$USER" -s nanogpt-api-key -w
```

(It prompts for the key, so the key never touches shell history.) Never suggest `.env` files or plaintext config.

---

## 7. Tests

- **Fake CLI:** replace `tests/fake-kimi-fixture.mjs` with `tests/fake-claude-fixture.mjs`.
  - It installs a fake `claude` that answers `--version` and `--help` (with the contract flags), and for `-p` prints one JSON result object shaped like §2. Behaviours: `ok`, `failure` (`is_error: true`), `denials`, `no-json`.
  - It logs argv plus the relevant env **names** (never values) to `claude-invocations.log`.
- **Unit tests:**
  - `buildClaudeArgs`: profiles, `=` forms, resume, model aliases, `:thinking`;
  - the env builder (deletions and additions);
  - the paid-model guard;
  - render truncation and footer;
  - the "key never persisted" test.
- **Port the rest:** `runtime.test.mjs`, `commands.test.mjs`, `stop-review-gate.test.mjs` and `cli-contract.test.mjs` move to the new names.
- **Live tests:** `tests/live.test.mjs`, skipped unless `NANOGPT_LIVE=1`. Automate the §2 boundary table plus:
  - resume answers from memory;
  - review of a tiny diff returns a verdict;
  - `setup` reports cost 0;
  - background task → status → result, and cancel.
- **CI:** `npm test` must pass on Node 18/20/22 without network access.

## 8. Acceptance criteria

- [ ] `npm test` is green offline; `node --check` passes on all `.mjs` files.
- [ ] `node plugins/nano/scripts/check-cli-contract.mjs` passes against real `claude` 2.1.278+.
- [ ] `NANOGPT_LIVE=1 npm test -- tests/live.test.mjs` is green on the user's machine.
- [ ] The `read` profile cannot modify anything, including via Bash, Edit, Write or redirects.
- [ ] The `write` profile cannot write outside cwd, cannot touch `.git`/settings, and runs only allowlisted Bash.
- [ ] The key never appears in state, logs or output (test).
- [ ] Paid models are refused without `--allow-paid`.
- [ ] `/nano:rescue --background` then `/nano:status` / `/nano:result` / `/nano:cancel` all work, and `--continue` resumes the right session.
- [ ] The README is rewritten for NanoGPT: install, setup (keychain command), commands, permission profiles, models and multipliers, and a privacy note (transcripts in `~/.claude/projects`; NanoGPT doesn't store prompts by default).
- [ ] `docs/nano-agent-experience.md` has entries from your own use of `bin/nano-agent` during implementation (see CLAUDE.md).

## 9. Suggested order (one PR per step, to `main`)

1. **Rename skeleton.** `git mv` the dirs and files, change names, manifests, package.json and NOTICE. Tests still use the fake kimi fixture, so they may need temporary skips. Keep this PR mechanical.
2. **Runtime.** `runtime.mjs` plus the fake claude fixture and unit tests. Port `task` in foreground only, with the `read` and `write` profiles.
3. **Background and continue.** stream-json progress, job records with `claudeSessionId`, `--continue`, cancel.
4. **Reviews.** `review`, `adversarial-review` and the stop gate on the `read` profile.
5. **Models and setup.** `models.mjs`, `setup` checks, the Bash allowlist config.
6. **Release.** CLI contract, the CI compat workflow, live tests, README, version 0.1.0, and a GitHub release.

## 10. Open questions (decide, then note the decision in the PR)

- Should `/nano:rescue` default to `write` (parity with kimi) or `read`? The recommendation is `write`, because rescue exists to act. Investigations can use `--read-only`.
- Should the default Bash allowlist auto-detect the project's test command (`npm test`, `just test`, `cargo test`)? That's convenient but widens the default. The recommendation is no: suggest it in `setup` output instead.
- The parent session's auto mode may block the forwarder's `node …/nano-companion.mjs task …` call as "Create Unsafe Agents" (this happened to `bin/nano-agent -w`). Test from an auto-mode session. If it's blocked, document an allow rule for the user to add, and don't try to evade the check.
