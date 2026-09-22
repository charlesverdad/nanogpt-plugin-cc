---
description: Check whether the local NanoGPT setup is ready and optionally toggle the stop-time review gate or configure the model / Bash allowlist
argument-hint: '[--model <id|alias>] [--allow-bash <prefix>] [--disallow-bash <prefix>] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" setup --json $ARGUMENTS
```

Present the checklist from the command's output to the user verbatim.

If the API key check fails (no NanoGPT API key found):
- Tell the user to run this command themselves (it prompts for the key so the key never lands in shell history or chat):
  `security add-generic-password -a "$USER" -s nanogpt-api-key -w`
- Never ask the user to paste the API key into the chat, and never suggest storing it in a `.env` file or any plaintext config.

If Claude Code is missing or too old:
- Tell the user to install or upgrade Claude Code to the required minimum version.

The `--model` option accepts a model id or alias (`default`, `heavy`, `alt`, `fast`) and stores the resolved model as the workspace default.

`--allow-bash <prefix>` (repeatable) adds a Bash command prefix to the workspace allowlist; `--disallow-bash <prefix>` (repeatable) removes one. The built-in defaults are `git status` and `ls`, and they cannot be removed.

When presenting the allowlist or a suggestion to extend it, pass on this risk: an allowlisted prefix runs with any arguments and the user's permissions. Any command that runs repository code (test runners, build tools, package scripts such as `npm test`) or takes an output-file option lets the NanoGPT model write or execute anything, because it can edit that code or config first. Only Edit/Write are confined to the working directory and kept out of `.git`.

The stop-time review gate is opt-in and off by default. Pass `--enable-review-gate` to require a fresh NanoGPT review before a session can stop, or `--disable-review-gate` to turn it back off. Be aware: when it is on, it runs a NanoGPT review every time a Claude session stops, which uses weekly quota every time.
