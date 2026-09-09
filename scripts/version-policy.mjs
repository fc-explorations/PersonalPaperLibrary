import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PACKAGE_PATH = resolve(ROOT, "package.json");
const LOCK_PATH = resolve(ROOT, "package-lock.json");
const APP_VERSION_PATH = resolve(ROOT, "src/version.ts");
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function parseVersion(value) {
  const normalized = String(value).trim().replace(/^v/, "");
  if (!VERSION_PATTERN.test(normalized)) throw new Error(`Expected a stable semantic version like 1.2.3, received: ${value}`);
  return normalized.split(".").map(Number);
}

export function incrementVersion(version, releaseType) {
  const [major, minor, patch] = parseVersion(version);
  if (!["major", "minor", "patch"].includes(releaseType)) throw new Error(`Unknown release type: ${releaseType}`);
  if (releaseType === "major") return `${major + 1}.0.0`;
  if (releaseType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function commitIsBreaking(commit) {
  const [header, ...body] = commit.trim().split(/\r?\n/);
  return /^\w+(?:\([^)]*\))?!:/.test(header) || body.some((line) => /^BREAKING[- ]CHANGE:/i.test(line.trim()));
}

export function releaseTypeForCommits(commits) {
  let releaseType = null;
  for (const commit of commits) {
    if (!commit.trim()) continue;
    if (commitIsBreaking(commit)) return "major";
    const header = commit.trim().split(/\r?\n/, 1)[0];
    const type = header.match(/^(\w+)(?:\([^)]*\))?!?:/)?.[1];
    if (type === "feat") releaseType = "minor";
    else if (type === "fix" || type === "perf" || type === "refactor") releaseType ||= "patch";
  }
  return releaseType;
}

function readPackageFiles() {
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
  const packageLock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  const appVersion = readFileSync(APP_VERSION_PATH, "utf8").match(/export const APP_VERSION = "([^"]+)";/)?.[1];
  if (!appVersion) throw new Error(`Could not find APP_VERSION in ${APP_VERSION_PATH}`);
  return { packageJson, packageLock, appVersion };
}

export function readSynchronizedVersion() {
  const { packageJson, packageLock, appVersion } = readPackageFiles();
  const versions = {
    packageJson: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages?.[""]?.version,
    appVersion,
  };
  for (const [name, version] of Object.entries(versions)) parseVersion(version ?? `${name} is missing`);
  const uniqueVersions = new Set(Object.values(versions));
  if (uniqueVersions.size !== 1) throw new Error(`Version files are out of sync: ${JSON.stringify(versions)}`);
  return String(packageJson.version);
}

function updateVersion(nextVersion) {
  parseVersion(nextVersion);
  const { packageJson, packageLock } = readPackageFiles();
  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  if (!packageLock.packages?.[""]) throw new Error("package-lock.json is missing its root package entry");
  packageLock.packages[""].version = nextVersion;

  writeFileSync(PACKAGE_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(LOCK_PATH, `${JSON.stringify(packageLock, null, 2)}\n`);
  const appVersion = readFileSync(APP_VERSION_PATH, "utf8");
  const updatedAppVersion = appVersion.replace(/export const APP_VERSION = "[^"]+";/, `export const APP_VERSION = "${nextVersion}";`);
  if (updatedAppVersion === appVersion) throw new Error(`Could not update APP_VERSION in ${APP_VERSION_PATH}`);
  writeFileSync(APP_VERSION_PATH, updatedAppVersion);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function latestVersionTag() {
  const tags = git(["tag", "--merged", "HEAD", "--list", "v[0-9]*.[0-9]*.[0-9]*"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => ({ tag, version: parseVersion(tag.slice(1)) }))
    .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return tags[0] ?? null;
}

function commitsSince(tag) {
  const range = tag ? `${tag.tag}..HEAD` : "HEAD";
  const log = git(["log", "--format=%B%x00", range]);
  return log.split("\0").filter(Boolean);
}

function printUsage() {
  console.error("Usage: node scripts/version-policy.mjs <check|next|bump|release> [major|minor|patch]");
}

function main() {
  const command = process.argv[2] ?? "check";
  const currentVersion = readSynchronizedVersion();

  if (command === "check") {
    console.log(`Version files are synchronized at ${currentVersion}.`);
    return;
  }

  if (command === "bump") {
    const releaseType = process.argv[3];
    if (!releaseType) throw new Error("bump requires major, minor, or patch");
    const nextVersion = incrementVersion(currentVersion, releaseType);
    updateVersion(nextVersion);
    console.log(nextVersion);
    return;
  }

  if (command === "next" || command === "release") {
    const tag = latestVersionTag();
    if (!tag) {
      console.error(`No version tag found. Bootstrap releases with: git tag v${currentVersion} && git push origin v${currentVersion}`);
      console.log("none");
      return;
    }
    if (tag.tag.slice(1) !== currentVersion) throw new Error(`Current version ${currentVersion} does not match latest release tag ${tag.tag}`);
    const releaseType = releaseTypeForCommits(commitsSince(tag));
    if (!releaseType) {
      console.log("none");
      return;
    }
    const nextVersion = incrementVersion(currentVersion, releaseType);
    if (command === "release") updateVersion(nextVersion);
    console.log(nextVersion);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();

