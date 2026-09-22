# nano-agent experience log

One row per `bin/nano-agent` use. Outcome is one of `as-is`, `fixed-up` or `discarded`. Raw metrics are in `~/.local/state/nano-agent/runs.jsonl`.

| Date | Model | Flags | Task | Outcome | Note |
|---|---|---|---|---|---|
| 2026-09-22 | z-ai/glm-5.2 | (read-only) | Summarize `lib/state.mjs` and where job state lives | as-is | Accurate, 2 turns, ~4k tokens, 19s |
| 2026-09-22 | z-ai/glm-5.2 | `-r` | Follow-up question on the previous session | as-is | Resume kept context; 3s |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b python3` | Permission boundary probe | as-is | All out-of-bounds writes and non-allowlisted Bash denied |
| 2026-09-22 | z-ai/glm-5.2 | (read-only) | Cross-check HANDOVER.md identifiers against kimi source; check whether the child sees CLAUDE.md | as-is | All identifiers verified; flagged 3 "port vs new code" nuances (1 applied). Child does not see CLAUDE.md. 22 turns, 66k tokens, 42s |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b 'npm test' -b 'node --test'` | Step 1: fix tests/ after the kimi→nano rename until `npm test` passes | as-is | 37 turns, 752k in-tokens, 232s. Correct and minimal; spotted that README assertions still need old names. `-w -b` passed the auto-mode check |
