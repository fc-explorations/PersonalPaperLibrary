export function parseVersion(value: string): number[];
export function incrementVersion(version: string, releaseType: string): string;
export function releaseTypeForCommits(commits: string[]): "major" | "minor" | "patch" | null;
export function readSynchronizedVersion(): string;

