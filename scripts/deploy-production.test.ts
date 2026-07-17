import { describe, expect, test } from "bun:test";
import {
  deploymentWorkflowArgs,
  normalizeGitHubRemote,
  parseDeployArgs,
  parseWorkflowRunId,
} from "./deploy-production";

describe("production deployment command", () => {
  test("requires an explicit market-state acknowledgement", () => {
    expect(() => parseDeployArgs([])).toThrow("pass --markets-disabled or --markets-enabled");
    expect(() => parseDeployArgs(["--markets-enabled", "--markets-disabled"])).toThrow(
      "pass exactly one market-state acknowledgement",
    );
  });

  test("parses a dry-run release ref", () => {
    expect(
      parseDeployArgs(["--dry-run", "--ref", "release-candidate", "--markets-disabled"]),
    ).toEqual({
      dryRun: true,
      marketState: "disabled",
      ref: "release-candidate",
    });
  });

  test("normalizes supported GitHub origin formats", () => {
    expect(normalizeGitHubRemote("git@github.com:thehamsti/koth-company.git\n")).toBe(
      "https://github.com/thehamsti/koth-company",
    );
    expect(normalizeGitHubRemote("https://github.com/thehamsti/koth-company.git")).toBe(
      "https://github.com/thehamsti/koth-company",
    );
  });

  test("extracts the exact dispatched workflow run", () => {
    expect(
      parseWorkflowRunId("https://github.com/thehamsti/koth-company/actions/runs/29428136288\n"),
    ).toBe("29428136288");
    expect(() => parseWorkflowRunId("workflow queued")).toThrow(
      "GitHub did not return the created workflow run URL",
    );
  });

  test("dispatches the trusted workflow with an immutable release", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(deploymentWorkflowArgs(sha, "enabled")).toEqual([
      "workflow",
      "run",
      "release-images.yml",
      "--repo",
      "thehamsti/koth-company",
      "--ref",
      "main",
      "--raw-field",
      `ref=${sha}`,
      "--raw-field",
      "deploy=true",
      "--raw-field",
      "markets=enabled",
    ]);
  });
});
