---
description: Cancel an active background NanoGPT job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" cancel "$ARGUMENTS"`
