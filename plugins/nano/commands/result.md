---
description: Show the stored final output for a finished NanoGPT job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/nano-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including stdout and stderr
- Any error messages
- Follow-up commands such as `/nano:status <id>` and `/nano:review`
