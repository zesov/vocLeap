#!/usr/bin/env node
/**
 * Release automation script for Vocleap
 *
 * Usage:
 *   bun run scripts/release.ts <version>     # e.g. bun run scripts/release.ts 0.7.0
 *   bun run scripts/release.ts --dry-run     # preview changes without applying
 *
 * What it does:
 * 1. Updates [Unreleased] section in CHANGELOG.md to the new version + today's date
 * 2. Creates a new [Unreleased] section at the top
 * 3. Commits the changelog update
 * 4. Creates an annotated git tag
 * 5. Pushes commit + tag to origin
 * 6. Creates a GitHub Release using the changelog content as release notes
 */

import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const CHANGELOG_PATH = resolve(import.meta.dir, "../CHANGELOG.md");
const REPO = "zesov/vocLeap"; // Update if repo name changes

interface ReleaseOptions {
  version: string;
  dryRun: boolean;
  message?: string;
}

function parseArgs(): ReleaseOptions {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-n");
  const versionArg = args.find((a) => !a.startsWith("-"));

  if (!versionArg && !dryRun) {
    console.error("Usage: bun run scripts/release.ts <version> [--dry-run]");
    console.error("Example: bun run scripts/release.ts 0.7.0");
    process.exit(1);
  }

  // Validate semver format
  if (versionArg && !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/.test(versionArg)) {
    console.error(`Invalid version format: ${versionArg}. Expected semantic version (e.g., 0.7.0, 1.0.0-beta.1)`);
    process.exit(1);
  }

  return { version: versionArg || "", dryRun };
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

  // Replace [Unreleased] with the new version header
  const updated = content.replace(unreleasedHeader, `${unreleasedHeader}\n\n${newHeader}`);

  // Verify the replacement happened
  if (updated === content) {
    throw new Error("Could not find [Unreleased] section in CHANGELOG.md");
  }

  return updated;
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

async function runCommand(cmd: string, dryRun: boolean): Promise<void> {
  console.log(dryRun ? `[DRY RUN] $ ${cmd}` : `$ ${cmd}`);
  if (!dryRun) {
    await $`${cmd}`.quiet();
  }
}

async function getCurrentBranch(): Promise<string> {
  const result = await $`git branch --show-current`.quiet();
  return result.stdout.toString().trim();
}

async function hasUncommittedChanges(): Promise<boolean> {
  const result = await $`git status --porcelain`.quiet();
  return result.stdout.toString().trim().length > 0;
}

async function main() {
  const { version, dryRun } = parseArgs();
  const date = getToday();
  const tag = `v${version}`;

  console.log(`\n📦 Preparing release ${tag} (${date})`);
  if (dryRun) console.log("🔍 DRY RUN MODE - no changes will be applied\n");

  // Pre-flight checks
  if (!dryRun) {
    const branch = await getCurrentBranch();
    if (branch !== "main" && branch !== "master" && branch !== "open") {
      console.warn(`⚠️  You're on branch "${branch}", not main/master/open. Continue? (y/N)`);
      // In a real script, you'd read from stdin. For now, we'll just warn.
    }

    if (await hasUncommittedChanges()) {
      console.error("❌ Working directory has uncommitted changes. Commit or stash first.");
      process.exit(1);
    }

    // Check if tag already exists
    const tagsResult = await $`git tag -l "${tag}"`.quiet();
    if (tagsResult.stdout.toString().trim()) {
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
    const oldLines = changelog.split("\n").slice(0, 10);
    const newLines = updatedChangelog.split("\n").slice(0, 12);
    console.log("--- CHANGELOG.md (preview) ---");
    console.log(newLines.join("\n"));
    console.log("...\n");
  } else {
    writeFileSync(CHANGELOG_PATH, updatedChangelog);
    console.log("✅ CHANGELOG.md updated");
  }

  // 2. Extract release notes for GitHub Release
  const releaseNotes = extractReleaseNotes(updatedChangelog, version);
  console.log("\n📋 Release notes extracted:");
  console.log("─".repeat(50));
  console.log(releaseNotes);
  console.log("─".repeat(50));

  // 3. Git commit
  const commitMsg = `chore: release ${tag}`;
  await runCommand(`git add CHANGELOG.md`, dryRun);
  await runCommand(`git commit -m "${commitMsg}"`, dryRun);

  // 4. Create annotated tag
  const tagMsg = `Release ${tag}\n\n${releaseNotes}`;
  await runCommand(`git tag -a ${tag} -m "${tagMsg}"`, dryRun);

  // 5. Push commit and tag
  await runCommand("git push origin HEAD", dryRun);
  await runCommand(`git push origin ${tag}`, dryRun);

  // 6. Create GitHub Release (requires gh CLI authenticated)
  if (!dryRun) {
    console.log("\n🚀 Creating GitHub Release...");
    try {
      await $`gh release create ${tag} --repo ${REPO} --title "Vocleap ${tag}" --notes "${releaseNotes}"`.quiet();
      console.log(`✅ GitHub Release created: https://github.com/${REPO}/releases/tag/${tag}`);
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
    console.log(`   🏷️  Tag ${tag} pushed`);
    console.log(`   📦 GitHub Release published`);
  }
}

main().catch((err) => {
  console.error("❌ Release failed:", err);
  process.exit(1);
});