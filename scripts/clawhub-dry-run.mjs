import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-travel-mode-clawpack-"));

try {
  const pack = run("npm", ["pack", "--pack-destination", tempDir, "--silent"], {
    captureStdout: true,
  });
  const tarballName = pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!tarballName) {
    throw new Error("npm pack did not report a tarball name");
  }

  const tarballPath = path.join(tempDir, tarballName);
  const sourceRepo = process.env.CLAWHUB_SOURCE_REPO ?? readGitSourceRepo();
  const sourceCommit = process.env.CLAWHUB_SOURCE_COMMIT ?? readGit(["rev-parse", "HEAD"]);
  const sourceRef = process.env.CLAWHUB_SOURCE_REF ?? readGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = readGit(["status", "--porcelain"]);
  if (status) {
    console.warn(
      "warning: working tree has uncommitted changes; source metadata will point at HEAD.",
    );
  }
  const sourceArgs = [
    "--source-repo",
    sourceRepo,
    "--source-commit",
    sourceCommit,
  ];
  if (sourceRef && sourceRef !== "HEAD") {
    sourceArgs.push("--source-ref", sourceRef);
  }

  run("clawhub", [
    "package",
    "publish",
    tarballPath,
    "--family",
    "code-plugin",
    "--dry-run",
    ...sourceArgs,
  ]);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function readGitSourceRepo() {
  const origin = readGit(["remote", "get-url", "origin"]);
  const sshMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }
  const httpsMatch = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }
  return origin;
}

function readGit(args) {
  return run("git", args, { captureStdout: true }).stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return { stdout: result.stdout ?? "" };
}
