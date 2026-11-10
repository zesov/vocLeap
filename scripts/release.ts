#!/usr/bin/env node
/**
 * Release automation script for Vocleap
 *
 * Usage:
 *   bun run scripts/release.ts --patch|--minor|--major [--dry-run]  # Auto-bump version
 *   bun run scripts/release.ts <version> [--dry-run]                  # Explicit version
 *   bun run scripts/release.ts --dry-run                              # Preview next patch
 *
 * What it does:
 * 1. Determines new version (auto-bump or explicit)
 * 2. Updates [Unreleased] section in CHANGELOG.md to the new version + today's date
 * 3. Creates a new [Unreleased] section at the top
 * 4. Updates package.json version
 * 5. Commits the changelog + package.json update
 * 6. Creates an annotated git tag
 * 7. Pushes commit + tag to origin
 * 8. Creates a GitHub Release using the changelog content as release notes
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const CHANGELOG_PATH = resolve(import.meta.dir, "../CHANGELOG.md");
const PACKAGE_JSON_PATH = resolve(import.meta.dir, "../package.json");
const REPO = "zesov/vocLeap"; // Update if repo name changes

interface ReleaseOptions {
  version: string;
  dryRun: boolean;
  bumpType?: "patch" | "minor" | "major";
}

function parseArgs(): ReleaseOptions {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-n");

  // Check for bump flags
  const bumpFlags = ["--patch", "--minor", "--major"] as const;
  const bumpType = bumpFlags.find((f) => args.includes(f));

  // Explicit version argument (non-flag)
  const versionArg = args.find((a) => !a.startsWith("-"));

  if (bumpType && versionArg) {
    console.error("❌ Cannot combine bump flag (--patch/--minor/--major) with explicit version");
    process.exit(1);
  }

  if (!bumpType && !versionArg && !dryRun) {
    console.error(`
Usage:
  bun run scripts/release.ts --patch|--minor|--major [--dry-run]  # Auto-bump version
  bun run scripts/release.ts <version> [--dry-run]                  # Explicit version
  bun run scripts/release.ts --dry-run                              # Preview next patch

Examples:
  bun run scripts/release.ts --patch      # 0.7.0 → 0.7.1
  bun run scripts/release.ts --minor      # 0.7.0 → 0.8.0
  bun run scripts/release.ts --major      # 0.7.0 → 1.0.0
  bun run scripts/release.ts 1.0.0-beta.1 # Explicit pre-release
  bun run scripts/release.ts --dry-run    # Preview what --patch would do
`);
    process.exit(1);
  }

  // Strip -- prefix from bump type
  const cleanBumpType = bumpType?.replace(/^--/, "") as "patch" | "minor" | "major" | undefined;

  return { version: versionArg || "", dryRun, bumpType: cleanBumpType };
}

function getCurrentVersion(): string {
  // Prefer latest git tag (source of truth for releases)
  try {
    const result = Bun.spawnSync(["git", "tag", "-l", "v*", "--sort=-v:refname"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout);
    const tags = output.trim().split("\n").filter(Boolean);
    if (tags.length > 0) {
      const latest = tags[0].replace(/^v/, "");
      if (/^\d+\.\d+\.\d+/.test(latest)) {
        return latest;
      }
    }
  } catch {
    // fall through
  }

  // Fallback: package.json
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
    if (pkg.version && /^\d+\.\d+\.\d+/.test(pkg.version)) {
      return pkg.version;
    }
  } catch {
    // fall through
  }

  throw new Error("Could not determine current version. Check package.json or git tags.");
}

function bumpVersion(version: string, type: "patch" | "minor" | "major"): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-.*)?$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}. Expected X.Y.Z[-suffix]`);
  }

  const [, major, minor, patch, suffix = ""] = match;
  const nums = { major: +major, minor: +minor, patch: +patch };

  switch (type) {
    case "major":
      nums.major++;
      nums.minor = 0;
      nums.patch = 0;
      break;
    case "minor":
      nums.minor++;
      nums.patch = 0;
      break;
    case "patch":
      nums.patch++;
      break;
  }

  return `${nums.major}.${nums.minor}.${nums.patch}${suffix}`;
}

function getToday(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

function readChangelog(): string {
  return readFileSync(CHANGELOG_PATH, "utf-8");
}

function updateChangelog(content: string, version: string, date: string): string {
  const unreleasedHeader = "## [Unreleased]";
  const newHeader = `## [${version}] - ${date}`;

  // Replace [Unreleased] with the new version header + new [Unreleased] section
  const updated = content.replace(
    unreleasedHeader,
    `${unreleasedHeader}\n\n${newHeader}`
  );

  // Verify the replacement happened
  if (updated === content) {
    throw new Error("Could not find [Unreleased] section in CHANGELOG.md");
  }

  return updated;
}

function updatePackageJson(version: string): void {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
  pkg.version = version;
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");
}

function extractReleaseNotes(content: string, version: string): string {
  const versionHeader = `## [${version}]`;
  const nextVersionHeader = /^## \[/m;

  const startIdx = content.indexOf(versionHeader);
  if (startIdx === -1) {
    throw new Error(`Could not find version header for ${version}`);
  }

  // Find the next version header after this one
  const afterStart = content.slice(startIdx + versionHeader.length);
  const nextMatch = afterStart.match(nextVersionHeader);
  const endIdx = nextMatch ? startIdx + versionHeader.length + nextMatch.index! : content.length;

  const section = content.slice(startIdx, endIdx).trim();

  // Remove the version header line itself for release notes body
  const lines = section.split("\n");
  const bodyLines = lines.slice(1).filter((line) => line.trim() !== "");

  return bodyLines.join("\n");
}

/**
 * Run a shell command using Bun.spawnSync for reliable execution
 */
function runShell(cmd: string[], dryRun: boolean): { stdout: string; stderr: string; exitCode: number } {
  console.log(dryRun ? `[DRY RUN] $ ${cmd.join(" ")}` : `$ ${cmd.join(" ")}`);
  if (dryRun) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };
}

/**
 * Run a shell command string (for complex commands with pipes, etc.)
 */
function runShellString(cmd: string, dryRun: boolean): { stdout: string; stderr: string; exitCode: number } {
  console.log(dryRun ? `[DRY RUN] $ ${cmd}` : `$ ${cmd}`);
  if (dryRun) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  const result = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };
}

async function getCurrentBranch(): Promise<string> {
  const { stdout } = runShell(["git", "branch", "--show-current"], false);
  return stdout.trim();
}

async function hasUncommittedChanges(): Promise<boolean> {
  const { stdout } = runShell(["git", "status", "--porcelain"], false);
  return stdout.trim().length > 0;
}

async function main() {
  const { version: explicitVersion, dryRun, bumpType } = parseArgs();

  // Determine version
  const currentVersion = getCurrentVersion();
  let version: string;

  if (explicitVersion) {
    version = explicitVersion;
  } else if (bumpType) {
    version = bumpVersion(currentVersion, bumpType);
  } else {
    // dry-run without bump flag → preview patch
    version = bumpVersion(currentVersion, "patch");
  }

  const date = getToday();
  const tag = `v${version}`;

  console.log(`\n📦 Preparing release ${tag} (${date})`);
  console.log(`   Current: v${currentVersion} → New: ${tag}`);
  if (dryRun) console.log("🔍 DRY RUN MODE - no changes will be applied\n");

  // Pre-flight checks
  if (!dryRun) {
    const branch = await getCurrentBranch();
    if (branch !== "main" && branch !== "master" && branch !== "open") {
      console.warn(`⚠️  You're on branch "${branch}", not main/master/open. Continue? (y/N)`);
    }

    if (await hasUncommittedChanges()) {
      console.error("❌ Working directory has uncommitted changes. Commit or stash first.");
      process.exit(1);
    }

    // Check if tag already exists
    const { stdout: tagsOut } = runShell(["git", "tag", "-l", tag], false);
    if (tagsOut.trim()) {
      console.error(`❌ Tag ${tag} already exists.`);
      process.exit(1);
    }
  }

  // 1. Read and update CHANGELOG.md
  console.log("\n📝 Updating CHANGELOG.md...");
  const changelog = readChangelog();
  const updatedChangelog = updateChangelog(changelog, version, date);

  if (dryRun) {
    // Show diff preview
    const newLines = updatedChangelog.split("\n").slice(0, 12);
    console.log("--- CHANGELOG.md (preview) ---");
    console.log(newLines.join("\n"));
    console.log("...\n");
  } else {
    writeFileSync(CHANGELOG_PATH, updatedChangelog);
    console.log("✅ CHANGELOG.md updated");
  }

  // 2. Update package.json
  console.log("\n📦 Updating package.json...");
  if (dryRun) {
    console.log(`   version: "${currentVersion}" → "${version}"`);
  } else {
    updatePackageJson(version);
    console.log("✅ package.json updated");
  }

  // 3. Extract release notes for GitHub Release
  const releaseNotes = extractReleaseNotes(updatedChangelog, version);
  console.log("\n📋 Release notes extracted:");
  console.log("─".repeat(50));
  console.log(releaseNotes || "(empty - add entries to [Unreleased] before releasing)");
  console.log("─".repeat(50));

  if (!dryRun && !releaseNotes.trim()) {
    console.warn("⚠️  Release notes are empty. Consider adding entries to [Unreleased] in CHANGELOG.md");
  }

  // 4. Git commit
  const commitMsg = `chore: release ${tag}`;
  runShellString(`git add CHANGELOG.md package.json`, dryRun);
  runShellString(`git commit -m "${commitMsg}"`, dryRun);

  // 5. Create annotated tag
  const tagMsg = `Release ${tag}\n\n${releaseNotes}`;
  runShellString(`git tag -a ${tag} -m "${tagMsg}"`, dryRun);

  // 6. Push commit and tag
  runShellString("git push origin HEAD", dryRun);
  runShellString(`git push origin ${tag}`, dryRun);

  // 7. Create GitHub Release (requires gh CLI authenticated)
  if (!dryRun) {
    console.log("\n🚀 Creating GitHub Release...");
    try {
      const { exitCode } = runShellString(
        `gh release create ${tag} --repo ${REPO} --title "Vocleap ${tag}" --notes "${releaseNotes.replace(/"/g, '\\"')}"`,
        false
      );
      if (exitCode === 0) {
        console.log(`✅ GitHub Release created: https://github.com/${REPO}/releases/tag/${tag}`);
      } else {
        throw new Error("gh release create failed");
      }
    } catch (e) {
      console.warn("⚠️  Failed to create GitHub Release (gh CLI not available or not authenticated).");
      console.warn("   You can create it manually at: https://github.com/${REPO}/releases/new");
      console.warn("   Tag:", tag);
      console.warn("   Title: Vocleap ${tag}");
    }
  }

  console.log(`\n✨ Release ${tag} complete!`);
  if (!dryRun) {
    console.log(`   📄 CHANGELOG.md updated`);
    console.log(`   📦 package.json version bumped`);
    console.log(`   🏷️  Tag ${tag} pushed`);
    console.log(`   📦 GitHub Release published`);
  }
}

main().catch((err) => {
  console.error("❌ Release failed:", err);
  process.exit(1);
});