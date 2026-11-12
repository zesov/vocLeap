#!/usr/bin/env node
/**
 * Release automation script for Vocleap
 *
 * Usage:
 *   bun run release --patch|--minor|--major [--dry-run]   # Auto-bump version
 *   bun run release <version> [--dry-run]                  # Explicit version
 *   bun run release --dry-run                              # Preview next patch
 *
 * Flags:
 *   --dry-run, -n     Preview only; nothing is written, committed or pushed
 *   --allow-empty     Allow a release when [Unreleased] has no entries
 *   --skip-checks     Skip the typecheck + unit-test gate before tagging
 *   --skip-backmerge  Skip the automatic main → dev backmerge after the release
 *   --yes             Non-interactive: accept non-release branches without prompting
 *
 * What it does:
 * 1. Pre-flight: clean worktree, tag free, branch policy (release branches run
 *    unattended; anything else prompts for confirmation)
 * 2. Gates: `tsc --noEmit` + unit tests unless --skip-checks
 * 3. CHANGELOG.md: moves the [Unreleased] entries under a new
 *    `## [version] - date` header (line-based, so content always lands in the
 *    version it shipped with). An empty [Unreleased] aborts unless
 *    --allow-empty
 * 4. package.json version bump
 * 5. Commit, annotated tag (argv-array spawn, so backticks/quotes in the
 *    notes are never interpreted by a shell), push branch + tag
 * 6. GitHub Release from a --notes-file temp file
 * 7. Backmerges main → dev so the preview branch never lags behind the
 *    release commit (skipped with --skip-backmerge or when the release
 *    branch isn't main)
 *
 * Every git step aborts the script on a non-zero exit code, so a tag can
 * never point at a commit that predates the release changes.
 */

import { readFileSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createInterface } from "node:readline/promises";

const CHANGELOG_PATH = resolve(import.meta.dir, "../CHANGELOG.md");
const PACKAGE_JSON_PATH = resolve(import.meta.dir, "../package.json");
const REPO = "zesov/vocLeap"; // Update if repo name changes
const RELEASE_BRANCHES = ["main", "master"];

interface ReleaseOptions {
  version: string;
  dryRun: boolean;
  bumpType?: "patch" | "minor" | "major";
  allowEmpty: boolean;
  skipChecks: boolean;
  skipBackmerge: boolean;
  yes: boolean;
}

const KNOWN_FLAGS = new Set([
  "--patch",
  "--minor",
  "--major",
  "--dry-run",
  "-n",
  "--allow-empty",
  "--skip-checks",
  "--skip-backmerge",
  "--yes",
]);

function usage(): string {
  return `
Usage:
  bun run release --patch|--minor|--major [--dry-run]   # Auto-bump version
  bun run release <version> [--dry-run]                  # Explicit version
  bun run release --dry-run                              # Preview next patch

Flags:
  --dry-run, -n     Preview only; nothing is written, committed or pushed
  --allow-empty     Allow a release when [Unreleased] has no entries
  --skip-checks     Skip the typecheck + unit-test gate before tagging
  --skip-backmerge  Skip the automatic main → dev backmerge after the release
  --yes             Non-interactive: accept non-release branches without prompting
`;
}

function parseArgs(): ReleaseOptions {
  const args = process.argv.slice(2);

  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`❌ Unknown flag(s): ${unknown.join(", ")}`);
    console.error(usage());
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const bumpFlags = ["--patch", "--minor", "--major"] as const;
  const bumpType = bumpFlags.find((f) => args.includes(f));
  const versionArg = args.find((a) => !a.startsWith("-"));

  if (bumpType && versionArg) {
    console.error("❌ Cannot combine bump flag (--patch/--minor/--major) with explicit version");
    console.error(usage());
    process.exit(1);
  }

  if (!bumpType && !versionArg && !dryRun) {
    console.error(usage());
    process.exit(1);
  }

  return {
    version: versionArg || "",
    dryRun,
    bumpType: bumpType?.replace(/^--/, "") as ReleaseOptions["bumpType"],
    allowEmpty: args.includes("--allow-empty"),
    skipChecks: args.includes("--skip-checks"),
    skipBackmerge: args.includes("--skip-backmerge"),
    yes: args.includes("--yes"),
  };
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function getCurrentVersion(): string {
  // Prefer the latest STABLE git tag (prereleases like v1.0.0-beta.1 are not
  // the baseline the next stable release bumps from).
  try {
    const result = Bun.spawnSync(["git", "tag", "-l", "v*", "--sort=-v:refname"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const tags = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
    const stable = tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t));
    if (stable) return stable.slice(1);
  } catch {
    // fall through
  }

  // Fallback: package.json
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
    if (typeof pkg.version === "string" && SEMVER_RE.test(pkg.version)) {
      return pkg.version;
    }
  } catch {
    // fall through
  }

  throw new Error("Could not determine current version. Check package.json or git tags.");
}

function bumpVersion(version: string, type: "patch" | "minor" | "major"): string {
  const match = version.match(SEMVER_RE);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected X.Y.Z[-suffix]`);
  }

  // Bumping out of a prerelease drops the suffix (semver.inc semantics):
  // 1.0.0-beta.1 --patch -> 1.0.0, never 1.0.1-beta.1.
  const nums = { major: +match[1], minor: +match[2], patch: +match[3] };

  switch (type) {
    case "major":
      nums.major += 1;
      nums.minor = 0;
      nums.patch = 0;
      break;
    case "minor":
      nums.minor += 1;
      nums.patch = 0;
      break;
    case "patch":
      nums.patch += 1;
      break;
  }

  return `${nums.major}.${nums.minor}.${nums.patch}`;
}

function getToday(): string {
  // Local calendar date, not UTC: a release before 08:00 HKT must not be
  // dated yesterday.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readChangelog(): string {
  return readFileSync(CHANGELOG_PATH, "utf-8");
}

interface ChangelogUpdate {
  content: string;
  releaseNotes: string;
  hasEntries: boolean;
}

/**
 * Moves the [Unreleased] body under a new `## [version] - date` header.
 * Line-based: content can never end up stranded under an older version
 * header, and `## [0.9.1]` can never collide with `## [0.9.10]`.
 */
function updateChangelog(content: string, version: string, date: string): ChangelogUpdate {
  const lines = content.split("\n");
  const unreleasedIdx = lines.findIndex((l) => l.trim() === "## [Unreleased]");
  if (unreleasedIdx === -1) {
    throw new Error("Could not find [Unreleased] section in CHANGELOG.md");
  }

  let sectionEnd = unreleasedIdx + 1;
  while (sectionEnd < lines.length && !lines[sectionEnd].startsWith("## ")) {
    sectionEnd += 1;
  }

  const body = lines.slice(unreleasedIdx + 1, sectionEnd);
  let last = body.length;
  while (last > 0 && body[last - 1].trim() === "") last -= 1;
  const entries = body.slice(0, last);
  const hasEntries = entries.some((l) => l.trim().startsWith("-"));

  const newHeader = `## [${version}] - ${date}`;
  const rebuilt = [
    ...lines.slice(0, unreleasedIdx),
    "## [Unreleased]",
    "",
    newHeader,
    ...entries,
    "",
    ...lines.slice(sectionEnd),
  ];

  return {
    content: rebuilt.join("\n"),
    releaseNotes: entries.join("\n"),
    hasEntries,
  };
}

function updatePackageJson(version: string): void {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  pkg.version = version;
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command as an argv array. No shell involvement, so changelog text
 * with backticks, quotes or $ signs can never be interpreted.
 */
function run(cmd: string[], options: { dryRun?: boolean; quiet?: boolean } = {}): RunResult {
  if (!options.quiet) {
    console.log(options.dryRun ? `[DRY RUN] $ ${cmd.join(" ")}` : `$ ${cmd.join(" ")}`);
  }
  if (options.dryRun) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };
}

/** Run a mutating command and abort the release when it fails. */
function mustRun(cmd: string[], dryRun: boolean, remediation?: string): RunResult {
  const result = run(cmd, { dryRun });
  if (!dryRun && result.exitCode !== 0) {
    console.error(`❌ Command failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
    if (result.stderr.trim()) console.error(result.stderr.trim());
    if (remediation) console.error(remediation);
    process.exit(1);
  }
  return result;
}

function getCurrentBranch(): string {
  const { stdout } = run(["git", "branch", "--show-current"], { quiet: true });
  return stdout.trim();
}

function hasUncommittedChanges(): boolean {
  const { stdout } = run(["git", "status", "--porcelain"], { quiet: true });
  return stdout.trim().length > 0;
}

async function confirmBranch(branch: string, yes: boolean): Promise<void> {
  if (RELEASE_BRANCHES.includes(branch)) return;
  if (yes) {
    console.warn(`⚠️  Releasing from non-release branch "${branch}" (--yes).`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error(
      `❌ Branch "${branch}" is not a release branch (${RELEASE_BRANCHES.join(", ")}). ` +
        "Re-run with --yes to proceed, or switch branches."
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `⚠️  You're on branch "${branch}", not ${RELEASE_BRANCHES.join("/")}. Continue? (y/N) `
    );
    if (answer.trim().toLowerCase() !== "y") {
      console.error("Aborted.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function ghAvailable(): boolean {
  return run(["gh", "--version"], { quiet: true }).exitCode === 0;
}

async function main() {
  const { version: explicitVersion, dryRun, bumpType, allowEmpty, skipChecks, skipBackmerge, yes } = parseArgs();

  const currentVersion = getCurrentVersion();
  let version: string;

  if (explicitVersion) {
    if (!SEMVER_RE.test(explicitVersion)) {
      console.error(`❌ Invalid version: ${explicitVersion}. Expected X.Y.Z[-suffix]`);
      process.exit(1);
    }
    version = explicitVersion;
  } else if (bumpType) {
    version = bumpVersion(currentVersion, bumpType);
  } else {
    // dry-run without bump flag → preview patch
    version = bumpVersion(currentVersion, "patch");
  }

  const date = getToday();
  const tag = `v${version}`;
  const branch = getCurrentBranch();

  console.log(`\n📦 Preparing release ${tag} (${date})`);
  console.log(`   Current: v${currentVersion} → New: ${tag} (branch: ${branch || "?"})`);
  if (dryRun) console.log("🔍 DRY RUN MODE - no changes will be applied\n");

  // Pre-flight checks (dry-run previews them without enforcing)
  if (!dryRun) {
    if (hasUncommittedChanges()) {
      console.error("❌ Working directory has uncommitted changes. Commit or stash first.");
      process.exit(1);
    }

    const { stdout: tagsOut } = run(["git", "tag", "-l", tag], { quiet: true });
    if (tagsOut.trim()) {
      console.error(`❌ Tag ${tag} already exists.`);
      process.exit(1);
    }

    await confirmBranch(branch, yes);
  }

  // Gates: never tag a broken build. They are read-only, so they run for
  // real even on --dry-run: the preview should tell you whether the actual
  // release would pass the gate.
  if (!skipChecks) {
    console.log("\n🧪 Running checks (tsc + unit tests)...");
    mustRun(["bunx", "tsc", "--noEmit"], false, "Fix the type errors, or pass --skip-checks to release anyway.");
    mustRun(["bun", "test", "tests/unit"], false, "Fix the failing tests, or pass --skip-checks to release anyway.");
    console.log("✅ Checks passed");
  }

  // 1. CHANGELOG.md: move [Unreleased] entries under the new version header
  console.log("\n📝 Updating CHANGELOG.md...");
  const update = updateChangelog(readChangelog(), version, date);

  if (!update.hasEntries && !allowEmpty) {
    console.error(
      "❌ [Unreleased] has no entries — nothing to release. " +
        "Add changelog entries first, or pass --allow-empty."
    );
    process.exit(1);
  }
  if (!update.hasEntries) {
    console.warn("⚠️  [Unreleased] is empty; releasing an empty section (--allow-empty).");
  }

  if (dryRun) {
    const newLines = update.content.split("\n").slice(0, 16);
    console.log("--- CHANGELOG.md (preview) ---");
    console.log(newLines.join("\n"));
    console.log("...\n");
  } else {
    writeFileSync(CHANGELOG_PATH, update.content);
    console.log("✅ CHANGELOG.md updated");
  }

  // 2. package.json
  console.log("\n📦 Updating package.json...");
  if (dryRun) {
    console.log(`   version: "${currentVersion}" → "${version}"`);
  } else {
    updatePackageJson(version);
    console.log("✅ package.json updated");
  }

  // 3. Release notes preview
  const releaseNotes = update.releaseNotes;
  console.log("\n📋 Release notes extracted:");
  console.log("─".repeat(50));
  console.log(releaseNotes || "(empty)");
  console.log("─".repeat(50));

  const ghReady = !dryRun && ghAvailable();
  if (!dryRun && !ghReady) {
    console.warn("⚠️  gh CLI not available/authenticated — the GitHub Release step will be skipped.");
  }

  // 4. Commit (abort on failure so the tag can never precede the changes)
  const commitMsg = `chore: release ${tag}`;
  mustRun(
    ["git", "add", "CHANGELOG.md", "package.json"],
    dryRun,
    "Nothing was committed or tagged; review the modified files with git diff."
  );
  mustRun(["git", "commit", "-m", commitMsg], dryRun);

  // 5. Annotated tag — argv-array spawn: backticks/quotes in the notes are data
  const tagMsg = `Release ${tag}\n\n${releaseNotes}`;
  mustRun(["git", "tag", "-a", tag, "-m", tagMsg], dryRun);

  // 6. Push branch + tag
  mustRun(
    ["git", "push", "origin", branch],
    dryRun,
    `The tag ${tag} exists locally but was not pushed. Delete it with \`git tag -d ${tag}\` if you redo the release.`
  );
  mustRun(
    ["git", "push", "origin", tag],
    dryRun,
    `The tag ${tag} exists locally but was not pushed. Push it with \`git push origin ${tag}\`, or delete it with \`git tag -d ${tag}\`.`
  );

  // 7. GitHub Release from a notes file (no shell quoting involved)
  if (dryRun) {
    console.log(`[DRY RUN] gh release create ${tag} --repo ${REPO} --notes-file <temp>`);
  } else if (!ghReady) {
    console.warn(`⚠️  Skipped the GitHub Release. Create it manually: https://github.com/${REPO}/releases/new?tag=${tag}`);
  } else {
    console.log("\n🚀 Creating GitHub Release...");
    const notesPath = join(mkdtempSync(join(tmpdir(), "vocleap-release-")), "notes.md");
    writeFileSync(notesPath, releaseNotes);
    const result = run([
      "gh",
      "release",
      "create",
      tag,
      "--repo",
      REPO,
      "--title",
      `Vocleap ${tag}`,
      "--notes-file",
      notesPath,
    ]);
    if (result.exitCode === 0) {
      console.log(`✅ GitHub Release created: https://github.com/${REPO}/releases/tag/${tag}`);
    } else {
      console.warn("⚠️  Failed to create the GitHub Release (the tag is pushed).");
      console.warn(`   You can create it manually at: https://github.com/${REPO}/releases/new?tag=${tag}`);
      if (result.stderr.trim()) console.warn(result.stderr.trim());
    }
  }

  // 8. Backmerge the release commit into dev: the preview branch must never
  // lag behind main (the release commit bumps CHANGELOG.md/package.json on
  // main only). Non-fatal — the release itself is already shipped.
  if (dryRun) {
    console.log("[DRY RUN] git checkout dev && git merge main && git push origin dev");
  } else if (skipBackmerge) {
    console.log("\n⏭️  Skipping the main → dev backmerge (--skip-backmerge).");
  } else if (branch !== "main") {
    console.warn(`\n⚠️  Released from "${branch}", not main — skipping the dev backmerge.`);
  } else if (run(["git", "rev-parse", "--verify", "refs/heads/dev"], { quiet: true }).exitCode !== 0) {
    console.warn("\n⚠️  No local dev branch — skipped the backmerge (set it up with: git checkout -b dev origin/dev).");
  } else {
    console.log("\n🔁 Backmerging main → dev...");
    let backmerged = true;
    for (const cmd of [["git", "checkout", "dev"], ["git", "merge", "main"], ["git", "push", "origin", "dev"]]) {
      const r = run(cmd);
      if (r.exitCode !== 0) {
        console.error(`❌ Backmerge failed at: ${cmd.join(" ")}`);
        if (r.stderr.trim()) console.error(r.stderr.trim());
        backmerged = false;
        break;
      }
    }
    if (backmerged) {
      console.log("✅ dev synced with the release (staying on dev for the next feature branch)");
    } else {
      console.warn("⚠️  Finish the backmerge by hand: git checkout dev && git merge main && git push origin dev");
    }
  }

  console.log(`\n✨ Release ${tag} complete!`);
  if (!dryRun) {
    console.log(`   📄 CHANGELOG.md updated ([Unreleased] entries moved under ${tag})`);
    console.log(`   📦 package.json version bumped to ${version}`);
    console.log(`   🏷️  Tag ${tag} pushed`);
    console.log(`   📦 GitHub Release published`);
  }
}

main().catch((err) => {
  console.error("❌ Release failed:", err);
  process.exit(1);
});
