# nano-agent experience log

One row per `bin/nano-agent` use. Outcome is one of `as-is`, `fixed-up` or `discarded`. Raw metrics are in `~/.local/state/nano-agent/runs.jsonl`.

| Date | Model | Flags | Task | Outcome | Note |
|---|---|---|---|---|---|
| 2026-09-22 | z-ai/glm-5.2 | (read-only) | Summarize `lib/state.mjs` and where job state lives | as-is | Accurate, 2 turns, ~4k tokens, 19s |
| 2026-09-22 | z-ai/glm-5.2 | `-r` | Follow-up question on the previous session | as-is | Resume kept context; 3s |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b python3` | Permission boundary probe | as-is | All out-of-bounds writes and non-allowlisted Bash denied |
| 2026-09-22 | z-ai/glm-5.2 | (read-only) | Cross-check HANDOVER.md identifiers against kimi source; check whether the child sees CLAUDE.md | as-is | All identifiers verified; flagged 3 "port vs new code" nuances (1 applied). Child does not see CLAUDE.md. 22 turns, 66k tokens, 42s |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b 'npm test' -b 'node --test'` | Step 1: fix tests/ after the kimi→nano rename until `npm test` passes | as-is | 37 turns, 752k in-tokens, 232s. Correct and minimal; spotted that README assertions still need old names. `-w -b` passed the auto-mode check |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b 'node --test <file>'` | Step 2: write tests/fake-claude-fixture.mjs (fake `claude` with 6 behaviours) plus its self-test from a detailed spec | as-is | 8 turns, 68k in-tokens, 61s. Followed a long spec exactly, including the "never log the key" rule |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b 'node --test <file>'` | Step 2: unit tests for the runtime.mjs security core (key, env, profiles, args) | as-is | 9 turns, 85k, 91s. **Found a real bug** in orchestrator-written code: newline check ran after whitespace collapse. Told not to fix, so it wrote a failing test and reported it: ideal behaviour |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b 'node --test <file>'` | Step 2: output helpers (JSON/stream parsing, runClaude spawn, footer, truncation, metrics log) + 53 tests | fixed-up | 18 turns, 314k, 157s. Correct; missed an `error` handler on child stdin (EPIPE), which the review caught |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b 'node --test <file>'` | Step 2: repeatable `multiValueOptions` in args.mjs + tests | as-is | 7 turns, 32k, 29s |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b ...contract cmds -b "claude --help"` | Step 6 (done early): port CLI contract manifest, checker, tests and compat workflow from kimi to claude | as-is | 25 turns, 572k, 138s. 19/19 tests; checked the real `claude --help` itself. One `…; echo "exit=$?"` compound command was denied by the prefix rule, as intended |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b "node --test <file>"` | Step 5: new lib/models.mjs (aliases, catalog fetch + 24h cache + builtin fallback, paid guard, :thinking, multiplier warnings) + 39 tests | as-is | 7 turns, 108k, 84s. Matched the spec closely, including "never store the key in the cache" |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b "node --test <file>"` | Step 5: new lib/account.mjs (live ping, subscription usage, formatting) + 25 tests | as-is | 7 turns, 90k, 117s. Scrubs the key from every returned string and drops account identifiers, as asked |
| 2026-09-22 | z-ai/glm-5.2 | `-w -b "node --test tests/live.test.mjs" -b "node --check …"` | Step 6: tests/live.test.mjs boundary probes (write/read profiles, compound Bash, redirects, .git, resume), skipped unless NANOGPT_LIVE=1 | fixed-up | 10 turns, 167k, 139s. All 10 passed live (78s), but the denial tests only checked the filesystem, so a model that never tried would pass. A `-r` follow-up (61s, context kept) added hard `permission_denials` assertions; still 10/10 live |
| 2026-09-22 | z-ai/glm-5.2 | `-w` | Step 6: draft the NanoGPT README (14 specified sections) into docs/README.draft.md | pending | 17 turns, 95k, 47s. Review pending |
