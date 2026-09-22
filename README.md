# nanogpt-plugin-cc

Use NanoGPT subscription models from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who have a NanoGPT subscription and want to push well-scoped work — bug investigations, mechanical fixes, code reviews — onto subscription-included open-weight models (GLM, DeepSeek, Qwen, MiniMax, and others) from the workflow they already have. Calls to subscription-included models cost $0 per call and count against a weekly token quota. The UX mirrors the kimi and codex plugins: slash commands, background jobs, and a thin forwarding subagent.

## How It Works

A Claude Code plugin subagent shares the parent's API endpoint, so it cannot run on a non-Anthropic model in-process. Instead, this plugin spawns Claude Code itself headless (`claude -p --restricted ...`) with `ANTHROPIC_BASE_URL` pointed at NanoGPT's Anthropic-compatible endpoint. The NanoGPT model then runs as a restricted, sandboxed child process with an explicit tool allowlist. A companion script (`nano-companion.mjs`) handles job management, output rendering, and session resume.

## Requirements

- **Node.js 18.18 or later**
- **Claude Code 2.1.278 or later** on your PATH
- **A NanoGPT subscription** and API key

## Install

Add the marketplace in Claude Code:

```
/plugin marketplace add charlesverdad/nanogpt-plugin-cc
```

Install the plugin:

```
/plugin install nano@nanogpt-plugin-cc
```

Then run:

```
/nano:setup
```

`/nano:setup` checks Node, `claude`, the CLI contract, your API key, a live ping to the default model, your subscription status, and the review gate state. It tells you what is ready and what needs attention.

A simple first run:

```
/nano:review --background
/nano:status
/nano:result
```

## API Key Setup

Store the key in the OS keychain. Never put it in a `.env` file or plaintext config.

**macOS:**

```
security add-generic-password -a "$USER" -s nanogpt-api-key -w
```

The command prompts for the key, so it never lands in your shell history.

**Linux:**

```
secret-tool store --label="NanoGPT API key" service nanogpt-api-key
```

**Or for the current session only:**

```
export NANOGPT_API_KEY=<your key>
```

The key is resolved fresh for each run and is never written to job files, logs, or rendered output. `/nano:setup` reports the source (e.g. "macOS keychain" or "NANOGPT_API_KEY environment variable") but never the value.

## Commands

| Command | Description |
| --- | --- |
| `/nano:setup` | Check whether NanoGPT is ready; configure default model and Bash allowlist. |
| `/nano:rescue` | Delegate a task (investigation, fix, follow-up) to a NanoGPT model. |
| `/nano:review` | Run a read-only NanoGPT review on your current work. |
| `/nano:adversarial-review` | Run a steerable challenge review that questions the design. |
| `/nano:status` | Show running and recent NanoGPT jobs for this repo. |
| `/nano:result` | Show the full stored output for a finished job. |
| `/nano:cancel` | Cancel an active background job. |

### /nano:rescue

```
/nano:rescue [--background|--wait] [--continue|--fresh] [--model <id|alias>] [--thinking] [--read-only] [--allow-bash <prefix>] [--allow-paid] <task>
```

Hands a task to NanoGPT through the `nano:nano-rescue` subagent. Use it to investigate a bug, try a fix, or continue a previous NanoGPT session. By default the task runs in the foreground; use `--background` to run it as a background job.

- `--background` / `--wait` — run as a background job or wait in the foreground (default: foreground).
- `--continue` / `--fresh` — resume the latest NanoGPT task for this repo, or start a new session. If neither is given, the plugin offers to continue the latest task.
- `--model <id|alias>` — select a model by id or alias (see Models below). If omitted, the workspace default is used.
- `--thinking` — use the `:thinking` variant of the selected model when it exists.
- `--read-only` — run with the `read` permission profile (no Edit, Write, or Bash).
- `--allow-bash <prefix>` — add a Bash prefix to the allowlist for this run (repeatable).
- `--allow-paid` — allow a non-subscription (pay-per-token) model. Refused otherwise.

Examples:

```
/nano:rescue investigate why the tests started failing
/nano:rescue --background investigate the regression
/nano:rescue --model heavy fix the issue
/nano:rescue --continue apply the top fix from the last run
/nano:rescue --read-only explore the authentication flow
```

### /nano:review

```
/nano:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]
```

Runs a read-only NanoGPT review on your current uncommitted changes or your branch compared to a base ref. The NanoGPT model can read files but cannot edit them or run commands. It is not steerable and does not take focus text. Use `--base <ref>` for branch review. `--scope` defaults to `auto`.

### /nano:adversarial-review

```
/nano:adversarial-review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]
```

Runs a steerable review that questions the chosen implementation, design tradeoffs, and assumptions. Like `/nano:review`, it is read-only: the NanoGPT model can read files but cannot edit them or run commands. It uses the same target selection as `/nano:review` and additionally accepts focus text after the flags. Use it to pressure-test specific risk areas like auth, data loss, race conditions, or rollback.

### /nano:setup

```
/nano:setup [--model <id|alias>] [--allow-bash <prefix>] [--disallow-bash <prefix>] [--enable-review-gate|--disable-review-gate]
```

Checks readiness and optionally configures workspace defaults.

- `--model <id|alias>` — set the workspace default model.
- `--allow-bash <prefix>` — add a Bash prefix to the workspace allowlist (repeatable).
- `--disallow-bash <prefix>` — remove a Bash prefix from the workspace allowlist (repeatable).
- `--enable-review-gate` / `--disable-review-gate` — toggle the stop-time review gate, which requires a fresh NanoGPT review before a session can stop. Off by default.

### /nano:status

```
/nano:status [job-id] [--wait] [--all]
```

Shows running and recent jobs for this repo. With a job id, shows full detail for that job. `--wait` blocks until the job finishes. `--all` lists all recorded jobs for the current session (not only the most recent ones); jobs from other sessions are not shown.

### /nano:result

```
/nano:result [job-id]
```

Shows the full stored output for a finished job. Defaults to the latest finished job.

### /nano:cancel

```
/nano:cancel [job-id]
```

Cancels an active background job. Without a job id, it cancels the single active job for the current session; if there are several active jobs in this session, it errors and asks for a job id. Pass a job id to target a specific job.

## Setup Checks

`/nano:setup` runs these checks in order and reports each one:

1. **Node version** — at least 18.18.
2. **claude on PATH** — `claude --version` is at least 2.1.278.
3. **CLI contract** — `claude --help` exposes the required flags (`--restricted`, `--strict-mcp-config`, `--tools`, `--permission-mode`, `--allowedTools`, `--output-format`, `--resume`, `--model`, `-p`).
4. **API key source** — the key resolves from the keychain or environment. The source is printed, never the value.
5. **Live ping** — a minimal request to the default model on NanoGPT's messages endpoint returns a valid response.
6. **Subscription active with remaining weekly quota** — checked against NanoGPT's subscription usage endpoint (`GET {base}/subscription/v1/usage`), which reports `active` and `weeklyInputTokens.remaining`. The per-request `usage.cost` field is the upstream price and can be non-zero even for calls covered by the subscription (observed on `z-ai/glm-5.2` with a $0 balance), so it is shown for information only and is not used to detect the subscription.
7. **Review gate state** — enabled or disabled.

`ready` is true only when all checks pass.

## Permission Profiles

The headless child runs under `--restricted`, which ignores your user/project settings, hooks, and plugins. `--permission-mode dontAsk` auto-denies anything not on the allowlist. Denied tool calls are listed in the output footer as `denied=...`; you rerun with `--allow-bash` to grant the missing command.

| Profile | Used by | Tools | Allowed |
| --- | --- | --- | --- |
| `read` | `review`, `adversarial-review`, the stop gate, `rescue --read-only` | Read, Glob, Grep | Read, Glob, Grep |
| `write` | `rescue` (default) | Read, Glob, Grep, Edit, Write, Bash | Read, Glob, Grep, Edit (`./**`), Write (`./**`), Bash (allowlisted prefixes only) |

The default Bash allowlist for the `write` profile is: `git status`, `git diff`, `git log`, `git show`, `ls`. If the allowlist is empty, Bash is dropped from the toolset entirely.

`--restricted` blocks writes to settings files and `.git`. File edits are confined to the working directory. Shell compound commands (`&&`), command substitutions (`$(...)`), pipes, and redirects outside the workspace are denied under the prefix rules — these were verified live.

Rather than widening the defaults, add your test command per workspace. For example:

```
/nano:setup --allow-bash "npm test"
```

You can also add a prefix for a single run:

```
/nano:rescue --allow-bash "npm test" fix the failing test
```

## Models

| Alias | Model id |
| --- | --- |
| `default` | `z-ai/glm-5.2` |
| `heavy` | `z-ai/glm-5.3` |
| `alt` | `minimax/minimax-m3` |
| `fast` | `z-ai/glm-5.3-flash` |

The workspace default is set with `/nano:setup --model <id|alias>` and stored in plugin state.

**Quota multipliers:** `z-ai/glm-5.3` and `deepseek/deepseek-v4-pro` count input tokens at 2x against your weekly quota. A one-line warning is printed when the multiplier is greater than 1.

**Thinking mode:** `--thinking` selects the `<model>:thinking` variant when it exists in the catalog. If no thinking variant exists, a warning is printed and the base model runs.

**Catalog:** the model list is fetched from NanoGPT (`GET {base}/v1/models?detailed=true`) and cached for 24 hours in plugin data. If the fetch fails, a small built-in fallback catalog is used. The cache never stores the API key.

**Paid models:** models where `subscription.included` is not `true` are refused unless `--allow-paid` is passed. The error names two or three included alternatives.

## Output

For a `rescue` task, the result text is rendered inline, capped at `NANO_MAX_INLINE_CHARS` (default 8000 characters). If the output is truncated, the footer notes where to find the full text:

```
… truncated, full output: /nano:result <job-id>
```

Use `/nano:result <job-id>` to see the complete output.

Every run ends with a footer line in this format, with raw integer token counts (not abbreviated):

```
[nano] model=z-ai/glm-5.2 turns=4 tokens=31240in/1187out secs=21 session=0b6f…
```

When tool calls were denied, the footer ends with `denied=` and the denied tool plus detail, for example:

```
[nano] model=z-ai/glm-5.2 turns=4 tokens=31240in/1187out secs=21 session=0b6f… denied=Bash(rm -rf build)
```

| Field | Meaning |
| --- | --- |
| `model` | The model id used for the run. |
| `turns` | Number of conversational turns. |
| `tokens` | Input tokens (including cache reads) and output tokens, as raw integers. |
| `secs` | Wall-clock duration in seconds. |
| `session` | The Claude Code session id (used by `--continue` to resume). |
| `denied` | Present only when tool calls were denied. Lists the denied tool and detail, e.g. `Bash(rm -rf build)`. Rerun with `--allow-bash` to grant the command. |

Run metrics are appended as one JSON line per run to `${CLAUDE_PLUGIN_DATA}/runs.jsonl` (falling back to `$TMPDIR/nano-companion/runs.jsonl`).

## Calling the Companion Directly

The main Claude thread may run the companion script directly via Bash, skipping the forwarding subagent when you want the cheapest path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" task ...
```

This avoids the subagent hop and is documented in the `nano-runtime` skill.

## Auto Mode

In testing (Claude Code 2.1.278, 2026-09-22), auto mode allowed the companion's `node .../nano-companion.mjs task ...` call, including the default write profile. Auto mode can still block it as "Create Unsafe Agents" in other setups. If that happens, add an allow rule to `permissions.allow` in your Claude Code settings (for example `.claude/settings.local.json`). Rules that match an allow rule skip the auto-mode classifier. The rule needs a wildcard after `.mjs` because the plugin quotes the script path:

```json
{
  "permissions": {
    "allow": ["Bash(node *nano-companion.mjs* task *)"]
  }
}
```

Permission rules match the literal command text, so `${CLAUDE_PLUGIN_ROOT}` can't be used in them. The plugin never tries to bypass the check.

## Privacy

Headless runs write transcripts to `~/.claude/projects/<cwd-slug>/<session>.jsonl`. These are kept so that `--continue` can resume a previous session. NanoGPT says it does not store prompts by default. Prompts and repository content you send do go to NanoGPT and the model provider.

## Development

```bash
npm test                                    # offline, uses a fake claude
NANOGPT_LIVE=1 npm test -- tests/live.test.mjs   # live tests against NanoGPT
NANOGPT_LIVE=1 node --test tests/live.test.mjs   # run only the live tests directly
node plugins/nano/scripts/check-cli-contract.mjs # verify claude --help flags
find plugins -name '*.mjs' -print0 | xargs -0 -n1 node --check  # syntax check
```

`npm test` runs on Node 18/20/22 without network access.

The live tests use the real NanoGPT API key from the keychain and cost subscription quota, so run them deliberately.

## License

MIT. Forked from [kimi-plugin-cc](https://github.com/charlesverdad/kimi-plugin-cc) (MIT), itself derived from [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0). See `NOTICE` for details.
