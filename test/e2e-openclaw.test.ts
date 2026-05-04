import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenClawCliCronClient } from "../src/cron-client.js";
import { normalizeCronJob } from "../src/hash.js";
import { createStatePaths } from "../src/state.js";
import { DEFAULT_CONFIG, TravelCronService } from "../src/service.js";

const execFileAsync = promisify(execFile);
const maybeDescribe = process.env.OPENCLAW_E2E === "1" ? describe : describe.skip;
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";

maybeDescribe("OpenClaw cron CLI e2e", () => {
  const prefix = `ctm-e2e-${Date.now()}-${process.pid}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-travel-mode-e2e-"));
  const createdIds: string[] = [];
  let moveId = "";
  let stayId = "";
  let implicitId = "";

  beforeAll(async () => {
    moveId = await createCronJob(`${prefix}-move`, "7 4 * * *", "America/Los_Angeles");
    stayId = await createCronJob(`${prefix}-stay`, "13 4 * * *", "America/Los_Angeles");
    implicitId = await createCronJob(`${prefix}-implicit`, "19 4 * * *");
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(createdIds.map((id) => runOpenClaw(["cron", "rm", id, "--json"])));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }, 120_000);

  it("drafts, applies, and restores disposable disabled cron jobs through the real CLI", async () => {
    const service = new TravelCronService(
      createStatePaths(stateDir),
      new OpenClawCliCronClient(OPENCLAW_BIN),
      undefined,
      DEFAULT_CONFIG,
    );

    const draft = await service.draft({
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      targetTz: "Europe/Berlin",
      filter: { nameIncludes: prefix },
    });

    expect(draft.ok).toBe(true);
    expect((draft.jobs as any[]).map((job) => job.id).sort()).toEqual(
      [implicitId, moveId, stayId].sort(),
    );
    expect((draft.jobs as any[]).find((job) => job.id === implicitId).editable).toBe(false);

    const committed = await service.commit({
      expectedRevision: draft.revision as number,
      decisions: [
        { id: moveId, decision: "move" },
        { id: stayId, decision: "stay" },
        { id: implicitId, decision: "needs_review" },
      ],
    });
    expect(committed.ok).toBe(true);

    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });
    expect(applied.ok).toBe(true);
    expect(applied.phase).toBe("active");

    expect((await showStable(moveId)).schedule.tz).toBe("Europe/Berlin");
    expect((await showStable(moveId)).enabled).toBe(false);
    expect((await showStable(stayId)).schedule.tz).toBe("America/Los_Angeles");
    expect((await showStable(implicitId)).schedule.tz).toBeUndefined();

    const restored = await service.restore({ expectedRevision: applied.revision as number });
    expect(restored.ok).toBe(true);
    expect(restored.phase).toBe("restored");
    expect((await showStable(moveId)).schedule.tz).toBe("America/Los_Angeles");
    expect((await showStable(moveId)).enabled).toBe(false);
  }, 180_000);

  async function createCronJob(name: string, expr: string, tz?: string): Promise<string> {
    const args = [
      "cron",
      "add",
      "--json",
      "--name",
      name,
      "--cron",
      expr,
      "--session",
      "isolated",
      "--message",
      `Cron Travel Mode e2e disposable job ${name}`,
      "--no-deliver",
      "--disabled",
    ];
    if (tz) {
      args.push("--tz", tz);
    }

    const created = await runOpenClawJson(args);
    const id = readJobId(created) ?? (await findJobIdByName(name));
    if (!id) {
      throw new Error(`Unable to resolve created cron job id for ${name}`);
    }
    createdIds.push(id);
    return id;
  }

  async function findJobIdByName(name: string): Promise<string | undefined> {
    const listed = await runOpenClawJson(["cron", "list", "--json"]);
    const jobs = Array.isArray(listed)
      ? listed
      : ((listed as { jobs?: unknown[]; items?: unknown[] }).jobs ??
        (listed as { items?: unknown[] }).items ??
        []);
    const match = jobs.find((job) => normalizeCronJob(job)?.name === name);
    return normalizeCronJob(match)?.id;
  }
});

async function showStable(jobId: string) {
  const stable = normalizeCronJob(await runOpenClawJson(["cron", "show", jobId, "--json"]));
  if (!stable) {
    throw new Error(`Unable to normalize cron job ${jobId}`);
  }
  return stable;
}

function readJobId(value: unknown): string | undefined {
  const stable = normalizeCronJob(value);
  if (stable) {
    return stable.id;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return typeof object.id === "string" ? object.id : readJobId(object.job);
  }
  return undefined;
}

async function runOpenClawJson(args: string[]): Promise<unknown> {
  const { stdout } = await runOpenClaw(args);
  return JSON.parse(stdout);
}

async function runOpenClaw(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(OPENCLAW_BIN, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
