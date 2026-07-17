import { resolve } from "node:path";

const repository = "thehamsti/koth-company";
const workflow = "release-images.yml";
const trustedWorkflowRef = "main";
const shaPattern = /^[0-9a-f]{40}$/;

export type DeployOptions = {
  dryRun: boolean;
  marketState: "disabled" | "enabled";
  ref: string;
};

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

function usage(): string {
  return `Usage: bun run deploy:production -- [options] --markets-disabled|--markets-enabled

Options:
  --ref <ref>          Deploy this local commit-ish (default: HEAD)
  --dry-run            Run every non-mutating preflight without dispatching
  --markets-disabled   Confirm production markets are disabled
  --markets-enabled    Confirm production markets are enabled
  --help               Show this help
`;
}

export function parseDeployArgs(args: readonly string[]): DeployOptions {
  let dryRun = false;
  let marketState: DeployOptions["marketState"] | null = null;
  let ref = "HEAD";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help") throw new Error(usage());
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--ref requires a value");
      ref = value;
      index += 1;
      continue;
    }
    if (argument === "--markets-disabled" || argument === "--markets-enabled") {
      const nextState = argument === "--markets-enabled" ? "enabled" : "disabled";
      if (marketState && marketState !== nextState) {
        throw new Error("pass exactly one market-state acknowledgement");
      }
      marketState = nextState;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }

  if (!marketState) {
    throw new Error("pass --markets-disabled or --markets-enabled");
  }

  return { dryRun, marketState, ref };
}

export function normalizeGitHubRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

export function parseWorkflowRunId(output: string): string {
  const escapedRepository = repository.replace("/", "\\/");
  const match = output.match(
    new RegExp(`https://github\\.com/${escapedRepository}/actions/runs/(\\d+)`),
  );
  if (!match?.[1]) {
    throw new Error("GitHub did not return the created workflow run URL");
  }
  return match[1];
}

export function deploymentWorkflowArgs(
  sha: string,
  marketState: DeployOptions["marketState"],
): string[] {
  if (!shaPattern.test(sha)) throw new Error("release must resolve to a full Git SHA");
  return [
    "workflow",
    "run",
    workflow,
    "--repo",
    repository,
    "--ref",
    trustedWorkflowRef,
    "--raw-field",
    `ref=${sha}`,
    "--raw-field",
    "deploy=true",
    "--raw-field",
    `markets=${marketState}`,
  ];
}

function run(command: string, args: readonly string[], cwd: string): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    stderr: decoder.decode(result.stderr),
    stdout: decoder.decode(result.stdout),
  };
}

function runInteractive(command: string, args: readonly string[], cwd: string): number {
  return Bun.spawnSync([command, ...args], {
    cwd,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }).exitCode;
}

function requireSuccess(result: CommandResult, description: string): string {
  if (result.exitCode === 0) return result.stdout.trim();
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(detail ? `${description}: ${detail}` : description);
}

function requireCommand(command: string): void {
  if (!Bun.which(command)) throw new Error(`required command not found: ${command}`);
}

export function runProductionDeploy(options: DeployOptions): void {
  const root = resolve(import.meta.dir, "..");
  for (const command of ["gh", "git"]) requireCommand(command);

  const worktree = requireSuccess(
    run("git", ["status", "--porcelain", "--untracked-files=all"], root),
    "could not inspect the worktree",
  );
  if (worktree) throw new Error("the worktree must be clean before deploying production");

  const origin = requireSuccess(
    run("git", ["remote", "get-url", "origin"], root),
    "could not resolve origin",
  );
  if (normalizeGitHubRemote(origin) !== `https://github.com/${repository}`) {
    throw new Error(`origin must be https://github.com/${repository}.git`);
  }

  const sha = requireSuccess(
    run("git", ["rev-parse", "--verify", `${options.ref}^{commit}`], root),
    `could not resolve ${options.ref}`,
  );
  if (!shaPattern.test(sha)) throw new Error(`${options.ref} did not resolve to a full Git SHA`);

  requireSuccess(
    run("gh", ["auth", "status", "--hostname", "github.com"], root),
    "GitHub authentication is unavailable",
  );
  requireSuccess(
    run("gh", ["api", "--silent", `repos/${repository}/commits/${sha}`], root),
    `${sha} is not available on GitHub; push it before deploying`,
  );

  const subject = requireSuccess(
    run("git", ["show", "--no-patch", "--format=%s", sha], root),
    "could not read the release subject",
  );
  console.info(`Release: ${sha}`);
  console.info(`Change:  ${subject}`);
  console.info(`Markets: ${options.marketState}`);

  if (options.dryRun) {
    console.info("Dry run complete; no workflow was dispatched.");
    return;
  }

  const dispatch = run("gh", deploymentWorkflowArgs(sha, options.marketState), root);
  const dispatchOutput = `${dispatch.stdout}\n${dispatch.stderr}`.trim();
  requireSuccess(dispatch, "could not dispatch the production workflow");
  const runId = parseWorkflowRunId(dispatchOutput);
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  console.info(`Workflow: ${runUrl}`);

  const watchExit = runInteractive(
    "gh",
    ["run", "watch", runId, "--repo", repository, "--compact", "--exit-status"],
    root,
  );
  if (watchExit !== 0) throw new Error(`production workflow failed; inspect ${runUrl}`);
  console.info(`Deployed ${sha} to https://koth.company`);
}

if (import.meta.main) {
  try {
    runProductionDeploy(parseDeployArgs(Bun.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      console.info(message);
      process.exit(0);
    }
    console.error(`error: ${message}`);
    process.exit(1);
  }
}
