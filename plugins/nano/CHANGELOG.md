# Changelog

## 0.1.0

- Forked from `kimi-plugin-cc` to run tasks and code reviews on NanoGPT subscription models from inside Claude Code.
- Runtime: spawns Claude Code itself headless (`claude -p --restricted ...`) against NanoGPT's Anthropic-compatible endpoint, with `read` and `write` permission profiles and an explicit tool allowlist.
- Model aliases (`default`, `heavy`, `alt`, `fast`) and a subscription guard that refuses pay-per-token models unless `--allow-paid` is passed. Catalog is fetched from NanoGPT and cached for 24h.
- Background task execution with stream-json progress, session id capture for resume, `/nano:status`, `/nano:result`, and `/nano:cancel`.
- `--continue` resumes the latest NanoGPT task for the current Claude session from the stored Claude session id.
- Setup checks: Node and `claude` versions, CLI contract, keychain/environment API key, a live ping, subscription quota, and the review-gate state.
- API key is resolved fresh from the OS keychain (macOS `security` / Linux `secret-tool`) or `NANOGPT_API_KEY`; never written to job files, logs, or output.
- Live tests (`tests/live.test.mjs`, skipped unless `NANOGPT_LIVE=1`) covering the permission boundary, resume, review, setup, background flow, and cancel.
- `nano:nano-rescue` agent prompt hardened to be AgentShield-clean: prompt-injection boundaries, no key disclosure, no output manipulation, single-call rate limit.

Earlier versions (as kimi-plugin-cc):

## 1.0.1

- Added a test suite covering the shared library and runtime integration (fake Kimi CLI).
- Added a version-bump script.
- Added a Kimi CLI version-compatibility check with CI.
- Relicensed under the MIT License, retaining upstream Apache-2.0 attribution for codex-plugin-cc (see NOTICE / LICENSE-APACHE).

## 1.0.0

- Initial version of the Kimi plugin for Claude Code
