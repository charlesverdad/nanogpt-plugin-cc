# Learnings

- NanoGPT's Anthropic endpoint base is `https://nano-gpt.com/api`, not the documented `/api/v1`.
- Don't use `claude --bare` for delegated agents: it drops Glob/Grep/Write whatever `--tools` says. Use `--restricted --strict-mcp-config` instead.
- `--tools` and `--allowedTools` are variadic: always use `--flag=value`, or they swallow the prompt.
- Don't use `--permission-mode auto` in a NanoGPT child: its safety check runs on the NanoGPT model, fails closed and burns ~30k tokens per check. Use `dontAsk` with an allowlist.
- Headless children don't see CLAUDE.md or the conversation (with `--restricted`), so tasks must be self-contained.
