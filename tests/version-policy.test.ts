import { describe, expect, it } from "vitest";
// The release script is intentionally plain ESM so it can run without a build step.
// @ts-expect-error The JavaScript release module is covered by the runtime tests below.
import { incrementVersion, parseVersion, releaseTypeForCommits, readSynchronizedVersion } from "../scripts/version-policy.mjs";

describe("version policy", () => {
  it("accepts stable semantic versions with an optional v prefix", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(() => parseVersion("1.2")).toThrow();
    expect(() => parseVersion("1.2.3-beta.1")).toThrow();
  });

  it.each([
    ["major", "2.0.0"],
    ["minor", "1.3.0"],
    ["patch", "1.2.4"],
  ])("increments %s versions from 1.2.3", (releaseType, expected) => {
    expect(incrementVersion("1.2.3", releaseType)).toBe(expected);
  });

  it("maps conventional commits to the highest required release", () => {
    expect(releaseTypeForCommits(["docs: update README"])).toBeNull();
    expect(releaseTypeForCommits(["fix: handle empty imports"])).toBe("patch");
    expect(releaseTypeForCommits(["fix: handle empty imports", "feat: add ISBN lookup"])).toBe("minor");
    expect(releaseTypeForCommits(["feat!: replace the storage API"])).toBe("major");
    expect(releaseTypeForCommits(["feat: replace the storage API\n\nBREAKING CHANGE: old exports are removed"])).toBe("major");
  });

  it("keeps the checked-in application versions synchronized", () => {
    expect(readSynchronizedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
