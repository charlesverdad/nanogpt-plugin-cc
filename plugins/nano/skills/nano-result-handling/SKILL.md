---
name: nano-result-handling
description: Internal guidance for presenting NanoGPT helper output back to the user
user-invocable: false
---

# NanoGPT Result Handling

When the helper returns NanoGPT output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If NanoGPT marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If NanoGPT made edits, say so explicitly and list the touched files when the helper provides them.
- Preserve the `[nano] ...` footer line that the companion prints (model, turns, tokens, seconds, session, and `denied=...` if present). Do not drop it or rewrite it.
- If the footer shows `denied=...`, tell the user which tool/command was denied and offer to rerun with `--allow-bash "<prefix>"` rather than working around it yourself. If that prefix runs repository code (a test runner, build tool or package script) or takes an output-file option, say that allowing it lets the model execute or write anything.
- If a warning about a 2× quota multiplier or a missing `:thinking` variant appears in the output, keep it. Do not suppress selection warnings.
- For `nano:nano-rescue`, do not turn a failed or incomplete NanoGPT run into a Claude-side implementation attempt. Report the failure and stop.
- For `nano:nano-rescue`, if NanoGPT was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious. The user must choose which to fix.
- If the helper reports malformed output or a failed NanoGPT run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/nano:setup` and do not improvise alternate auth flows.
