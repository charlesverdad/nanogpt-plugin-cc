# Learnings

- NanoGPT's Anthropic endpoint base is `https://nano-gpt.com/api`, not the documented `/api/v1`.
- Don't use `claude --bare` for delegated agents: it drops Glob/Grep/Write whatever `--tools` says. Use `--restricted --strict-mcp-config` instead.
- `--tools` and `--allowedTools` are variadic: always use `--flag=value`, or they swallow the prompt.
- Don't use `--permission-mode auto` in a NanoGPT child: its safety check runs on the NanoGPT model, fails closed and burns ~30k tokens per check. Use `dontAsk` with an allowlist.
- Headless children don't see CLAUDE.md or the conversation (with `--restricted`), so tasks must be self-contained.
- NanoGPT's raw `/v1/messages` `usage.cost` is the upstream price, not what you're billed: on 2026-09-22 `z-ai/glm-5.2` reported ~$0.00001 per ping with a $0 balance and `allowOverage: false`, and the tokens counted against the subscription quota. Don't use `cost == 0` to detect the subscription; use `GET {base}/subscription/v1/usage` (`active`, `weeklyInputTokens.remaining`).
- The authenticated `GET {base}/v1/models?detailed=true` includes `subscription.{included,inputTokenMultiplier}`; without `x-api-key` that field is missing.
- `claude -p --output-format stream-json` requires `--verbose`. API errors still produce a result object with `is_error: true` but `subtype: "success"`, so check `is_error`.
- A prompt starting with `-` is parsed as an option by `claude`; put the prompt after `--`.
- `gh` in this repo resolves to the `upstream` remote by default; pass `-R charlesverdad/nanogpt-plugin-cc`.
- Auto mode blocks `gh pr merge` without review ("Merge Without Review"); stack PRs and let the user merge.
