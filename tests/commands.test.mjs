import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "nano");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return NanoGPT's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/nano-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"NanoGPT review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(\.\.\., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return NanoGPT's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/nano-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"NanoGPT adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /uses the same review target selection as `\/nano:review`/i);
  assert.match(source, /It supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("commands directory exposes the expected user-facing commands", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command forwards to the nano-rescue subagent verbatim", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/nano-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/nano-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be NanoGPT's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  assert.match(rescue, /subagent_type: "nano:nano-rescue"/);
  assert.match(rescue, /do not call `Skill\(nano:nano-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /\[--background\|--wait\]/);
  assert.match(rescue, /\[--continue\]/);
  assert.match(rescue, /\[--model <model>\]/);
  assert.match(rescue, /\[--thinking\]/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current NanoGPT session/);
  assert.match(rescue, /Start a new NanoGPT session/);
  assert.match(rescue, /run the `nano:nano-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to the subagent/i);
  assert.match(rescue, /Leave `--thinking` unset unless the user explicitly asks for it/i);
  assert.match(rescue, /Leave the model unset unless the user explicitly asks for one/i);
  assert.match(rescue, /If the request includes `--continue`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--continue`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the NanoGPT companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /run `\/nano:setup`/i);

  assert.match(agent, /name: nano-rescue/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--thinking` unset unless the user explicitly requests it/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /Return the stdout of the `nano-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or NanoGPT cannot be invoked, return nothing/i);

  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or NanoGPT cannot be invoked, return nothing/i);

  assert.match(readme, /`kimi:kimi-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model`, Kimi chooses its own defaults/i);
  assert.match(readme, /### `\/kimi:setup`/);
  assert.match(readme, /### `\/kimi:review`/);
  assert.match(readme, /### `\/kimi:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/kimi:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/kimi:rescue`/);
  assert.match(readme, /### `\/kimi:status`/);
  assert.match(readme, /### `\/kimi:result`/);
  assert.match(readme, /### `\/kimi:cancel`/);
});

test("result and cancel commands are deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /nano-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /nano-companion\.mjs" cancel "\$ARGUMENTS"/);
});

test("internal runtime skill uses task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/nano-runtime/SKILL.md");

  assert.match(runtimeSkill, /nano-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /user-invocable: false/);
});

test("setup command points users to kimi install and login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /nano-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /https:\/\/moonshotai\.github\.io\/kimi-cli\//);
  assert.match(setup, /!kimi login/);
  assert.match(readme, /!kimi login/);
  assert.match(readme, /\/kimi:setup/);
});

test("review and adversarial-review prompts use kimi review framing", () => {
  const reviewPrompt = read("prompts/review.md");
  const adversarialPrompt = read("prompts/adversarial-review.md");

  assert.match(reviewPrompt, /senior software engineer performing a thorough code review/i);
  assert.match(reviewPrompt, /\{\{TARGET_LABEL\}\}/);
  assert.match(reviewPrompt, /\{\{REVIEW_INPUT\}\}/);
  assert.match(reviewPrompt, /Overall verdict \(approve \/ needs-attention \/ blocking\)/);

  assert.match(adversarialPrompt, /adversarial code review/i);
  assert.match(adversarialPrompt, /\{\{TARGET_LABEL\}\}/);
  assert.match(adversarialPrompt, /\{\{USER_FOCUS\}\}/);
  assert.match(adversarialPrompt, /\{\{REVIEW_INPUT\}\}/);
});
