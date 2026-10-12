---
description: Summarize NanoGPT run history, failures, latency and MCP tool usage
argument-hint: '[--days <n>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" usage "$ARGUMENTS"`

Return the command output verbatim to the user.
- Do not summarize, condense or add prose around it.
