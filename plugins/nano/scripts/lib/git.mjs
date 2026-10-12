import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

// Lockfiles inlined into a review diff blow the prompt up for no review value
// (a generated file, often hundreds of KB, that claude then refuses). They are
// excluded from the inline diff at any depth but still listed in the diff stat
// and changed-file list, and called out in an "Omitted from the inline diff"
// line. Not excluded from the diff stat or changed-file list: those are small
// and show the reviewer what changed.
const DEFAULT_LOCKFILE_EXCLUDES = Object.freeze([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock"
]);

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

/**
 * Validate and normalize repeatable `--exclude <glob>` patterns. A pattern
 * without `/` matches at any depth; a pattern with `/` is relative to the repo
 * root. Empty patterns, patterns with newlines, or patterns starting with `:`
 * (which would smuggle a git pathspec magic prefix) are rejected with a clear
 * error so the companion exits 1 instead of producing a confusing diff.
 */
export function normalizeExcludes(patterns = []) {
  const result = [];
  for (const raw of patterns) {
    const pattern = String(raw ?? "");
    if (!pattern) {
      throw new Error("Invalid --exclude pattern: pattern must not be empty.");
    }
    if (pattern.includes("\n")) {
      throw new Error(`Invalid --exclude pattern ${JSON.stringify(pattern)}: it must not contain newlines.`);
    }
    if (pattern.startsWith(":")) {
      throw new Error(`Invalid --exclude pattern ${JSON.stringify(pattern)}: it must not start with ':'.`);
    }
    result.push(pattern);
  }
  return result;
}

// Build the git pathspec arguments that exclude the default lockfiles (at any
// depth) plus the user's --exclude patterns, scoped to `-- .` so the diff is
// "everything under the repo root minus the exclusions". A user pattern with
// no `/` matches at any depth (`**/<pattern>`); one with `/` is relative to the
// repo root.
function buildExcludePathspecs(userExcludes = []) {
  const specs = [];
  for (const name of DEFAULT_LOCKFILE_EXCLUDES) {
    specs.push(`:(exclude,glob)**/${name}`);
  }
  for (const pattern of userExcludes) {
    const glob = pattern.includes("/") ? pattern : `**/${pattern}`;
    specs.push(`:(exclude,glob)${glob}`);
  }
  return specs;
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

// Format the "Omitted from the inline diff" line, or null when nothing was
// omitted. Lists at most 20 names (then "…") so the line stays readable.
function formatOmittedLine(omitted) {
  if (omitted.length === 0) {
    return null;
  }
  const shown = omitted.slice(0, 20);
  const suffix = omitted.length > 20 ? ", …" : "";
  return `Omitted from the inline diff: ${omitted.length} file(s) (lockfiles or --exclude): ${shown.join(", ")}${suffix}`;
}

// Names omitted from the inline diff = (all changed names) minus (names git
// keeps after applying the exclude pathspecs). Using git's own --name-only
// with the same pathspecs means the matching is identical to the inline diff,
// however the globs are interpreted. `nameOnlyArgs` is the full argv after
// `git` (e.g. ["diff", "--name-only", "<range>", "--", ".", ":(exclude,...)"]).
function collectOmittedFromNames(cwd, allNames, nameOnlyArgs) {
  const kept = new Set(
    gitChecked(cwd, nameOnlyArgs).stdout.trim().split("\n").filter(Boolean)
  );
  return allNames.filter((name) => !kept.has(name)).sort();
}

function collectWorkingTreeContext(cwd, state, userExcludes = []) {
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const pathspecArgs = ["--", ".", ...buildExcludePathspecs(userExcludes)];
  // No --binary: without it, binary files appear as
  // "Binary files a/x and b/x differ" (one line) instead of a base85 payload
  // that can be many MB. The diff stat and changed-file list are NOT excluded.
  const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff", ...pathspecArgs]).stdout;
  const unstagedDiff = gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff", ...pathspecArgs]).stdout;
  const keptUntracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", ...pathspecArgs])
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const inlineUntracked = state.untracked.filter((file) => keptUntracked.includes(file));
  const untrackedBody = inlineUntracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  const allChanged = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const omitted = collectOmittedForWorkingTree(cwd, allChanged, pathspecArgs);

  const sections = [
    { title: "Git Status", body: status, isDiff: false },
    ...(omitted.length > 0 ? [{ title: "Omitted from the inline diff", body: formatOmittedLine(omitted), isDiff: false }] : []),
    { title: "Staged Diff", body: stagedDiff, isDiff: true },
    { title: "Unstaged Diff", body: unstagedDiff, isDiff: true },
    { title: "Untracked Files", body: untrackedBody, isDiff: true }
  ];

  return buildContextDetails({
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    sections,
    changedFiles: allChanged,
    omitted
  });
}

// collectOmitted specialised for the working tree: the inline diff excludes
// staged, unstaged, and untracked files, so the kept set is the union of the
// three name-only listings under the same pathspecs.
function collectOmittedForWorkingTree(cwd, allNames, pathspecArgs) {
  if (pathspecArgs.length <= 2) {
    // only "--", "." with no exclude specs: nothing is omitted
    return [];
  }
  const kept = new Set();
  for (const base of [
    ["diff", "--name-only", "--cached"],
    ["diff", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ]) {
    for (const name of gitChecked(cwd, [...base, ...pathspecArgs]).stdout.trim().split("\n").filter(Boolean)) {
      kept.add(name);
    }
  }
  return allNames.filter((name) => !kept.has(name)).sort();
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

function collectBranchContext(cwd, baseRef, userExcludes = []) {
  const comparison = buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  const pathspecArgs = ["--", ".", ...buildExcludePathspecs(userExcludes)];
  const branchDiff = gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff", comparison.commitRange, ...pathspecArgs]).stdout;
  const omitted = collectOmittedFromNames(cwd, changedFiles, [
    "diff",
    "--name-only",
    comparison.commitRange,
    ...pathspecArgs
  ]);

  const sections = [
    { title: "Commit Log", body: logOutput, isDiff: false },
    { title: "Diff Stat", body: diffStat, isDiff: false },
    ...(omitted.length > 0 ? [{ title: "Omitted from the inline diff", body: formatOmittedLine(omitted), isDiff: false }] : []),
    { title: "Branch Diff", body: branchDiff, isDiff: true }
  ];

  return buildContextDetails({
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    sections,
    changedFiles,
    omitted,
    comparison
  });
}

// Shared shape builder: joins the sections into `content` (the inline version)
// and computes the inline diff text/bytes (the concatenation of the `isDiff`
// section bodies) so the caller can decide whether to spill to a file.
function buildContextDetails({ mode, summary, sections, changedFiles, omitted, comparison = null }) {
  const content = sections.map((section) => formatSection(section.title, section.body)).join("\n");
  const inlineDiffText = sections
    .filter((section) => section.isDiff)
    .map((section) => formatSection(section.title, section.body))
    .join("\n");
  return {
    mode,
    summary,
    sections,
    content,
    inlineDiffText,
    inlineDiffBytes: Buffer.byteLength(inlineDiffText, "utf8"),
    omittedFromInline: omitted,
    changedFiles,
    ...(comparison ? { comparison } : {})
  };
}

/**
 * Rebuild the review context after the inline diff has been spilled to a file.
 * The non-diff sections (Git Status, Commit Log, Diff Stat, Omitted) stay
 * inlined; every `isDiff` section collapses into one pointer block telling
 * claude where the full diff lives and how to read it in chunks.
 */
export function buildSpilledContent(sections, spillPath, bytes, lines) {
  const pointer = `The full diff (${bytes} bytes, ${lines} lines) is too large to inline. It is at ${spillPath}. Read it with the Read tool in chunks (offset/limit, about 1500 lines at a time). Use the diff stat above to prioritise.`;
  const out = [];
  let placed = false;
  for (const section of sections) {
    if (section.isDiff) {
      if (!placed) {
        out.push(formatSection("Diff", pointer));
        placed = true;
      }
    } else {
      out.push(formatSection(section.title, section.body));
    }
  }
  if (!placed) {
    out.push(formatSection("Diff", pointer));
  }
  return out.join("\n");
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const userExcludes = normalizeExcludes(options.excludes ?? []);

  let details;
  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    details = collectWorkingTreeContext(repoRoot, state, userExcludes);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef, userExcludes);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    ...details
  };
}
