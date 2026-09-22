---
description: Check whether the local NanoGPT CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" setup --json $ARGUMENTS
```

If the result says NanoGPT is unavailable:
- Tell the user to install NanoGPT CLI from https://moonshotai.github.io/kimi-cli/

If NanoGPT is installed but not authenticated:
- Tell the user to run `!kimi login`.

The stop-time review gate is optional and off by default. Pass
`--enable-review-gate` to require a fresh NanoGPT review before a session can stop,
or `--disable-review-gate` to turn it back off.

Presenting the result:
- Present the final setup output to the user.
