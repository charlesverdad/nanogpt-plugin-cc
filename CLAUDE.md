# nanogpt-plugin-cc

Claude Code plugin that hands off tasks and reviews to NanoGPT subscription models. It is built on kimi-plugin-cc and follows the structure of the official [codex-plugin-cc](https://github.com/openai/codex-plugin-cc). User docs are in `README.md`; hard-won facts about `claude -p` and NanoGPT are in `.claude/LEARNINGS.md`.

- Node ≥ 18.18, ESM `.mjs`, zero dependencies. Match the existing code style.
- Test: `npm test`. Syntax check: `find plugins -name '*.mjs' -print0 | xargs -0 -n1 node --check`. There's no justfile and no nix.
- Remotes: `origin` = charlesverdad/nanogpt-plugin-cc, `upstream` = charlesverdad/kimi-plugin-cc.

## NanoGPT offload with `bin/nano-agent`

Subagents started with the Agent tool always run on Claude. To save Claude tokens, and to gather real experience with this setup (half the point of this project), hand well-scoped work to NanoGPT with `bin/nano-agent`. It runs headless Claude Code on NanoGPT subscription models. Calls are included in the subscription but count against a 60M tok/week input quota, and cached input counts in full: every turn resends the whole conversation, so long multi-turn runs burn quota fast.

- **Usage:** `bin/nano-agent [-m model] [-w] [-b 'cmd prefix']... [-r session_id] "<self-contained task>"`, run from the repo root.
  - **Default:** read-only (Read/Glob/Grep).
  - **`-w`:** allows Edit/Write inside the current directory.
  - **`-b 'npm test'`:** allows Bash commands starting with that prefix.
  - **`-r <session>`:** resumes an earlier run (the session id is in the footer).
- **Output:** you get the final answer plus a `[nano-agent] …` footer. If the footer shows `denied=`, the agent needed something you didn't allow: rerun with a `-b` or `-w`.
- **Write self-contained tasks.** The child does not see this file or the conversation. Include the goal, file paths, conventions, how to verify (e.g. "run `npm test`" together with `-b 'npm test'`), and ask for a short report (its output becomes your input).
- **Parallel runs:** use Bash `run_in_background` for independent tasks.
- **Good fits:** code reviews, "how does X work" questions and other short or one-shot prompts. Hand long multi-turn implementation work to a Sonnet subagent instead.
- **Keep on Claude:** architecture and security-sensitive logic (key handling, permission profiles), final review. Always check nano output (`git diff`, `npm test`) before building on it.
- **Models** (subscription only; never `anthropic/*` or `openai/*`, which are pay-per-token):
  - default `z-ai/glm-5.2`; alternatives `minimax/minimax-m3`, `qwen/qwen3.8-27b` (1× quota)
  - hard problems: `z-ai/glm-5.3`, `deepseek/deepseek-v4-pro-0813` (2× quota)
  - trivial or fast: `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`
- **For a second opinion without file access,** `mcp__nanogpt__nanogpt_chat` also works (if that MCP is connected). Don't paste large files into it: you pay output tokens to write the prompt.

### Record the experience (required)

- **Metrics are logged automatically** to `~/.local/state/nano-agent/runs.jsonl`.
- **After each use, add a row to `docs/nano-agent-experience.md`:** the model, flags, a short task description, the outcome (`as-is` / `fixed-up` / `discarded`), and one line on what went right or wrong. Failures are the most useful data, so record them honestly.

### Permissions and secrets

- **Read-only calls normally pass auto mode.** `-w`/`-b` calls may be blocked by the auto-mode check ("Create Unsafe Agents"). If that happens, don't work around it. Tell the user they can add `"Bash(bin/nano-agent:*)"` to `permissions.allow` in `.claude/settings.local.json`.
- **The NanoGPT key is in the macOS keychain** (service `nanogpt-api-key`). Never read, print or store it. Tests must use fake keys.
