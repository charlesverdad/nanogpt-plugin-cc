import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpilledContent,
  collectReviewContext,
  normalizeExcludes,
  resolveReviewTarget
} from "../plugins/nano/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.equal(target.baseRef, "main");
  assert.match(context.content, /## Branch Diff/);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.explicit, true);
});

test("resolveReviewTarget honors explicit working-tree scope", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });

  assert.equal(target.mode, "working-tree");
  assert.equal(target.explicit, true);
});

test("resolveReviewTarget rejects unsupported scopes", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { scope: "staged" }),
    /Unsupported review scope "staged"/
  );
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline working-tree diffs and untracked content", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.mode, "working-tree");
  assert.equal(context.fileCount, 2);
  assert.match(context.content, /## Git Status/);
  assert.match(context.content, /## Unstaged Diff/);
  assert.match(context.content, /INLINE_MARKER/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext skips oversized untracked files by byte limit", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "huge.txt"), "x".repeat(24 * 1024 + 1));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### huge\.txt/);
  assert.match(context.content, /byte limit/);
});

// ---------------------------------------------------------------------------
// no --binary, lockfile/default excludes, --exclude patterns, spill content
// ---------------------------------------------------------------------------

function initRepoWithBase(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "initial"], { cwd });
}

test("collectReviewContext never inlines a binary payload (no GIT binary patch)", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  run("git", ["checkout", "-b", "feature/pngs"], { cwd });
  // A PNG header plus junk with NUL bytes: git only calls a file binary when
  // it sees a NUL in the first 8000 bytes, and then (without --binary) prints
  // "Binary files ... differ" instead of a base85 GIT binary patch.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 0)]);
  fs.writeFileSync(path.join(cwd, "snapshot.png"), png);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const x = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "add png"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.equal(context.content.includes("GIT binary patch"), false, "no base85 payload");
  // A new binary file diffs as "/dev/null and b/..."; a modified one as
  // "a/... and b/...". Both are one line, which is the point.
  assert.match(context.content, /Binary files \S* and b\/snapshot\.png differ/);
  assert.match(context.content, /\+export const x = 1;/);
});

test("collectReviewContext omits lockfiles from the inline diff but keeps them in Diff Stat and the Omitted line", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  run("git", ["checkout", "-b", "feature/locks"], { cwd });
  fs.writeFileSync(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n".repeat(40));
  fs.mkdirSync(path.join(cwd, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "deep", "nested.txt"), "nested content\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "touch lockfile"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  // Still listed as changed and in the diff stat...
  assert.ok(context.changedFiles.includes("pnpm-lock.yaml"));
  assert.match(context.content, /## Diff Stat[\s\S]*pnpm-lock\.yaml/);
  // ...but not inlined, and called out on the Omitted line.
  assert.doesNotMatch(context.content, /lockfileVersion: 9\.0/);
  assert.match(
    context.content,
    /Omitted from the inline diff: 1 file\(s\) \(lockfiles or --exclude\): pnpm-lock\.yaml/
  );
});

test("collectReviewContext excludes lockfiles at any depth", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  run("git", ["checkout", "-b", "feature/nested-locks"], { cwd });
  fs.mkdirSync(path.join(cwd, "packages", "app"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "app", "package-lock.json"), "{\n" + '"locked": true\n'.repeat(30) + "}\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "nested lockfile"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.doesNotMatch(context.content, /"locked": true/);
  assert.match(context.content, /packages\/app\/package-lock\.json/);
});

test("collectReviewContext applies a user --exclude pattern without / at any depth", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  run("git", ["checkout", "-b", "feature/gen"], { cwd });
  fs.mkdirSync(path.join(cwd, "docs", "generated"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "docs", "generated", "api.md"), "GENERATED_MARKER\n".repeat(10));
  fs.writeFileSync(path.join(cwd, "api.md"), "GENERATED_MARKER\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "export const y = 2;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "generated docs"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target, { excludes: ["api.md"] });

  assert.equal(context.content.includes("GENERATED_MARKER"), false);
  assert.match(context.content, /\+export const y = 2;/);
  assert.match(context.content, /Omitted from the inline diff: 2 file\(s\) \(lockfiles or --exclude\): api\.md, docs\/generated\/api\.md/);
});

test("collectReviewContext applies a user --exclude pattern with / relative to the repo root", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  run("git", ["checkout", "-b", "feature/docs"], { cwd });
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "docs", "keep.md"), "KEEP_ME\n");
  fs.mkdirSync(path.join(cwd, "notes"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "notes", "drop.md"), "DROP_ME\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "docs"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target, { excludes: ["docs/**"] });

  // "docs/**" is repo-root-relative, so only docs/keep.md is excluded; the
  // unrelated notes/drop.md stays inlined.
  assert.equal(context.content.includes("KEEP_ME"), false);
  assert.match(context.content, /\+DROP_ME/);
  assert.match(context.content, /Omitted from the inline diff: 1 file\(s\) \(lockfiles or --exclude\): docs\/keep\.md/);
});

test("collectReviewContext excludes matching untracked files from the inline body but lists them in Git Status", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  fs.writeFileSync(path.join(cwd, "yarn.lock"), "UNTRACKED_LOCKFILE_MARKER\n".repeat(10));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /## Git Status[\s\S]*yarn\.lock/);
  assert.equal(context.content.includes("UNTRACKED_LOCKFILE_MARKER"), false);
  assert.match(context.content, /Omitted from the inline diff: 1 file\(s\) \(lockfiles or --exclude\): yarn\.lock/);
});

test("collectReviewContext reports no Omitted line when nothing was excluded", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.doesNotMatch(context.content, /Omitted from the inline diff/);
  assert.match(context.content, /console\.log\('v2'\)/);
});

test("normalizeExcludes rejects empty, newline, and ':'-prefixed patterns", () => {
  assert.throws(() => normalizeExcludes([""]), /pattern must not be empty/);
  assert.throws(() => normalizeExcludes(["a\nb"]), /must not contain newlines/);
  assert.throws(() => normalizeExcludes([":(exclude)x"]), /must not start with ':'/);
  assert.deepEqual(normalizeExcludes(["docs/**", "*.snap"]), ["docs/**", "*.snap"]);
  assert.deepEqual(normalizeExcludes([]), []);
});

test("collectReviewContext exposes inlineDiffBytes so the caller can decide to spill", () => {
  const cwd = makeTempDir();
  initRepoWithBase(cwd);
  run("git", ["checkout", "-b", "feature/big"], { cwd });
  fs.writeFileSync(path.join(cwd, "big.txt"), "x".repeat(100_000));
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "big"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);

  assert.ok(context.inlineDiffBytes > 90_000, `expected a large inline diff, got ${context.inlineDiffBytes}`);
  assert.ok(context.inlineDiffText.includes("## Branch Diff"));
  assert.ok(context.content.includes(context.inlineDiffText));
});

test("buildSpilledContent keeps the small sections and replaces the diff bodies with one pointer", () => {
  const sections = [
    { title: "Commit Log", body: "* abc", isDiff: false },
    { title: "Diff Stat", body: " app.js | 2 ++", isDiff: false },
    { title: "Omitted from the inline diff", body: "Omitted from the inline diff: 1 file(s) (lockfiles or --exclude): pnpm-lock.yaml", isDiff: false },
    { title: "Branch Diff", body: "diff --git a/app.js b/app.js", isDiff: true }
  ];
  const content = buildSpilledContent(sections, "/tmp/nano-review-XYZ/review.diff", 12345, 900);

  assert.match(content, /## Commit Log[\s\S]*\* abc/);
  assert.match(content, /## Diff Stat[\s\S]*app\.js \| 2 \+\+/);
  assert.match(content, /Omitted from the inline diff: 1 file\(s\)/);
  assert.match(
    content,
    /The full diff \(12345 bytes, 900 lines\) is too large to inline\. It is at \/tmp\/nano-review-XYZ\/review\.diff\. Read it with the Read tool in chunks \(offset\/limit, about 1500 lines at a time\)\. Use the diff stat above to prioritise\./
  );
  assert.doesNotMatch(content, /diff --git a\/app\.js/);
});
