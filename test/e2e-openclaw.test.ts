import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenClawCliCronClient } from "../src/cron-client.js";
import { normalizeCronJob } from "../src/hash.js";
import { createStatePaths, loadState } from "../src/state.js";
import { DEFAULT_CONFIG, TravelCronService } from "../src/service.js";
import type { TravelCronState } from "../src/types.js";

const execFileAsync = promisify(execFile);
const maybeDescribe = process.env.OPENCLAW_E2E === "1" ? describe : describe.skip;
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "openclaw";

maybeDescribe("OpenClaw cron CLI e2e", () => {
  const prefix = `ctm-e2e-${Date.now()}-${process.pid}`;
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cron-travel-mode-e2e-"));
  const createdIds: string[] = [];
  const ids = {
    basicMoveDisabled: "",
    basicMoveEnabled: "",
    basicStay: "",
    basicImplicit: "",
    scheduled: "",
    missed: "",
    lateRestore: "",
    abort: "",
    drift: "",
  };

  beforeAll(async () => {
    ids.basicMoveDisabled = await createCronJob(
      `${prefix}-basic-move-disabled`,
      "7 4 * * *",
      { tz: "America/Los_Angeles" },
    );
    ids.basicMoveEnabled = await createCronJob(
      `${prefix}-basic-move-enabled`,
      "11 4 * * *",
      { tz: "America/Los_Angeles", enabled: true },
    );
    ids.basicStay = await createCronJob(`${prefix}-basic-stay`, "13 4 * * *", {
      tz: "America/Los_Angeles",
    });
    ids.basicImplicit = await createCronJob(`${prefix}-basic-implicit`, "19 4 * * *");
    ids.scheduled = await createCronJob(`${prefix}-scheduled`, "23 4 * * *", {
      tz: "America/Los_Angeles",
    });
    ids.missed = await createCronJob(`${prefix}-missed`, "29 4 * * *", {
      tz: "America/Los_Angeles",
    });
    ids.lateRestore = await createCronJob(`${prefix}-late-restore`, "31 4 * * *", {
      tz: "America/Los_Angeles",
    });
    ids.abort = await createCronJob(`${prefix}-abort`, "37 4 * * *", {
      tz: "America/Los_Angeles",
    });
    ids.drift = await createCronJob(`${prefix}-drift`, "41 4 * * *", {
      tz: "America/Los_Angeles",
    });
    await waitForJobIds(Object.values(ids));
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled(createdIds.map((id) => runOpenClaw(["cron", "rm", id, "--json"])));
    await removeJobsByPrefix(prefix);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }, 120_000);

  it("drafts, applies, and restores explicit-timezone jobs while preserving enabled state", async () => {
    const service = serviceFor("basic");
    const draft = await draftPlan(service, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      targetTz: "Europe/Berlin",
      filterName: `${prefix}-basic-`,
    });

    expect((draft.jobs as any[]).map((job) => job.id).sort()).toEqual(
      [
        ids.basicImplicit,
        ids.basicMoveDisabled,
        ids.basicMoveEnabled,
        ids.basicStay,
      ].sort(),
    );
    expect((draft.jobs as any[]).find((job) => job.id === ids.basicImplicit).editable).toBe(
      false,
    );

    const committed = await service.commit({
      expectedRevision: draft.revision as number,
      decisions: [
        { id: ids.basicMoveDisabled, decision: "move" },
        { id: ids.basicMoveEnabled, decision: "move" },
        { id: ids.basicStay, decision: "stay" },
        { id: ids.basicImplicit, decision: "needs_review" },
      ],
    });
    expect(committed.ok).toBe(true);

    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });
    expect(applied.ok).toBe(true);
    expect(applied.phase).toBe("active");

    expect(await showEssentials(ids.basicMoveDisabled)).toMatchObject({
      name: `${prefix}-basic-move-disabled`,
      enabled: false,
      cron: "7 4 * * *",
      tz: "Europe/Berlin",
    });
    expect(await showEssentials(ids.basicMoveEnabled)).toMatchObject({
      name: `${prefix}-basic-move-enabled`,
      enabled: true,
      cron: "11 4 * * *",
      tz: "Europe/Berlin",
    });
    expect((await showStable(ids.basicStay)).schedule.tz).toBe("America/Los_Angeles");
    expect((await showStable(ids.basicImplicit)).schedule.tz).toBeUndefined();

    const restored = await service.restore({ expectedRevision: applied.revision as number });
    expect(restored.ok).toBe(true);
    expect(restored.phase).toBe("restored");
    expect(await showEssentials(ids.basicMoveDisabled)).toMatchObject({
      enabled: false,
      tz: "America/Los_Angeles",
    });
    expect(await showEssentials(ids.basicMoveEnabled)).toMatchObject({
      enabled: true,
      tz: "America/Los_Angeles",
    });
  }, 180_000);

  it("passively activates a scheduled plan on the next tool call", async () => {
    const service = serviceFor("scheduled");
    const draft = await draftPlan(service, {
      startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      targetTz: "Europe/Berlin",
      filterName: `${prefix}-scheduled`,
    });
    const committed = await commitSingleMove(service, draft, ids.scheduled);
    const scheduled = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "scheduled",
    });
    expect(scheduled.phase).toBe("scheduled");
    expect((await showStable(ids.scheduled)).schedule.tz).toBe("America/Los_Angeles");

    mutateState("scheduled", (state) => {
      state.trip!.startsAt = new Date(Date.now() - 60_000).toISOString();
      state.trip!.endsAt = new Date(Date.now() + 60 * 60_000).toISOString();
      state.trip!.activationGraceMinutes = 10;
    });

    const status = await service.status();
    expect(status.phase).toBe("active");
    expect((await showStable(ids.scheduled)).schedule.tz).toBe("Europe/Berlin");

    const restored = await service.restore({ expectedRevision: status.revision as number });
    expect(restored.phase).toBe("restored");
    expect((await showStable(ids.scheduled)).schedule.tz).toBe("America/Los_Angeles");
  }, 180_000);

  it("marks a scheduled plan as missed_activation_noop after trip end without editing cron", async () => {
    const service = serviceFor("missed");
    const draft = await draftPlan(service, {
      startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      targetTz: "Europe/Berlin",
      filterName: `${prefix}-missed`,
    });
    const committed = await commitSingleMove(service, draft, ids.missed);
    const scheduled = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "scheduled",
    });
    expect(scheduled.phase).toBe("scheduled");

    mutateState("missed", (state) => {
      state.trip!.startsAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      state.trip!.endsAt = new Date(Date.now() - 60 * 60_000).toISOString();
    });

    const status = await service.status();
    expect(status.phase).toBe("missed_activation_noop");
    expect((await showStable(ids.missed)).schedule.tz).toBe("America/Los_Angeles");
  }, 180_000);

  it("requires confirmation before overdue late restore", async () => {
    const service = serviceFor("late-restore");
    const applied = await applySingleMove(service, ids.lateRestore, `${prefix}-late-restore`);
    expect(applied.phase).toBe("active");
    expect((await showStable(ids.lateRestore)).schedule.tz).toBe("Europe/Berlin");

    mutateState("late-restore", (state) => {
      state.trip!.endsAt = new Date(Date.now() - 60_000).toISOString();
      state.trip!.lateRestoreThresholdHours = 0;
    });

    const status = await service.status();
    const pending = status.pendingConfirmation as any;
    expect(pending.kind).toBe("late_restore");
    expect((await showStable(ids.lateRestore)).schedule.tz).toBe("Europe/Berlin");

    const restored = await service.restore({ confirmOperationId: pending.operationId });
    expect(restored.phase).toBe("restored");
    expect((await showStable(ids.lateRestore)).schedule.tz).toBe("America/Los_Angeles");
  }, 180_000);

  it("requires confirmation before early active abort restore", async () => {
    const service = serviceFor("abort");
    const applied = await applySingleMove(service, ids.abort, `${prefix}-abort`);
    expect(applied.phase).toBe("active");

    const abort = await service.recover({
      expectedRevision: applied.revision as number,
      action: "abort",
    });
    expect(abort.confirmationRequired).toBe(true);
    expect((await showStable(ids.abort)).schedule.tz).toBe("Europe/Berlin");

    const confirmed = await service.recover({
      action: "abort",
      confirmOperationId: abort.operationId as string,
    });
    expect(confirmed.phase).toBe("cancelled");
    expect((await showStable(ids.abort)).schedule.tz).toBe("America/Los_Angeles");
  }, 180_000);

  it("skips manually drifted moved jobs until force restore is confirmed", async () => {
    const service = serviceFor("drift");
    const applied = await applySingleMove(service, ids.drift, `${prefix}-drift`);
    expect(applied.phase).toBe("active");
    expect((await showStable(ids.drift)).schedule.tz).toBe("Europe/Berlin");

    await editJobTimezone(ids.drift, "Asia/Tokyo");
    expect((await showStable(ids.drift)).schedule.tz).toBe("Asia/Tokyo");

    const skipped = await service.restore({ expectedRevision: applied.revision as number });
    expect(skipped.ok).toBe(false);
    expect(skipped.phase).toBe("restore_failed_partial");
    expect(skipped.skippedJobIds).toEqual([ids.drift]);
    expect((await showStable(ids.drift)).schedule.tz).toBe("Asia/Tokyo");

    const forceRequest = await service.restore({
      expectedRevision: skipped.revision as number,
      force: true,
    });
    expect(forceRequest.confirmationRequired).toBe(true);

    const forced = await service.restore({
      force: true,
      confirmOperationId: forceRequest.operationId as string,
    });
    expect(forced.phase).toBe("restored");
    expect((await showStable(ids.drift)).schedule.tz).toBe("America/Los_Angeles");
  }, 180_000);

  async function createCronJob(
    name: string,
    expr: string,
    options: { tz?: string; enabled?: boolean } = {},
  ): Promise<string> {
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
    ];
    if (!options.enabled) {
      args.push("--disabled");
    }
    if (options.tz) {
      args.push("--tz", options.tz);
    }

    const createdResult = await runOpenClaw(args);
    const created = createdResult.stdout.trim()
      ? JSON.parse(createdResult.stdout)
      : undefined;
    const id = readJobId(created) ?? (await findJobIdByName(name));
    if (!id) {
      throw new Error(
        `Unable to resolve created cron job id for ${name}; stdout=${JSON.stringify(
          createdResult.stdout,
        )}; stderr=${JSON.stringify(createdResult.stderr)}`,
      );
    }
    createdIds.push(id);
    return id;
  }

  function serviceFor(name: string): TravelCronService {
    return new TravelCronService(
      createStatePaths(path.join(stateRoot, name)),
      new OpenClawCliCronClient(OPENCLAW_BIN, (_command, args) => runOpenClaw(args)),
      undefined,
      DEFAULT_CONFIG,
    );
  }

  async function draftPlan(
    service: TravelCronService,
    params: {
      startsAt: string;
      endsAt: string;
      targetTz: string;
      filterName: string;
    },
  ) {
    const draft = await service.draft({
      startsAt: params.startsAt,
      endsAt: params.endsAt,
      targetTz: params.targetTz,
      filter: { nameIncludes: params.filterName },
    });
    expect(draft).toMatchObject({ ok: true });
    return draft;
  }

  async function commitSingleMove(
    service: TravelCronService,
    draft: Awaited<ReturnType<TravelCronService["draft"]>>,
    jobId: string,
  ) {
    const committed = await service.commit({
      expectedRevision: draft.revision as number,
      decisions: [{ id: jobId, decision: "move" }],
    });
    expect(committed.ok).toBe(true);
    return committed;
  }

  async function applySingleMove(
    service: TravelCronService,
    jobId: string,
    filterName: string,
  ) {
    const draft = await draftPlan(service, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      targetTz: "Europe/Berlin",
      filterName,
    });
    const committed = await commitSingleMove(service, draft, jobId);
    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });
    expect(applied.ok).toBe(true);
    return applied;
  }

  function mutateState(name: string, mutator: (state: TravelCronState) => void): void {
    const paths = createStatePaths(path.join(stateRoot, name));
    const state = loadState(paths);
    if (!state) {
      throw new Error(`No state found for ${name}`);
    }
    mutator(state);
    fs.writeFileSync(paths.file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function findJobIdByName(name: string): Promise<string | undefined> {
    return (await listStableJobs()).find((job) => job.name === name)?.id;
  }

  async function waitForJobIds(jobIds: string[]): Promise<void> {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const visible = new Set((await listStableJobs()).map((job) => job.id));
      if (jobIds.every((id) => visible.has(id))) {
        return;
      }
      await sleep(250 * attempt);
    }
    throw new Error(`Created cron jobs were not visible in list: ${jobIds.join(", ")}`);
  }

  async function listStableJobs() {
    const listed = await runOpenClawJson(["cron", "list", "--all", "--json"]);
    const jobs = Array.isArray(listed)
      ? listed
      : ((listed as { jobs?: unknown[]; items?: unknown[] }).jobs ??
        (listed as { items?: unknown[] }).items ??
        []);
    return jobs
      .map((job) => normalizeCronJob(job))
      .filter((job): job is NonNullable<ReturnType<typeof normalizeCronJob>> => job !== null);
  }

  async function removeJobsByPrefix(namePrefix: string): Promise<void> {
    const listed = await runOpenClawJson(["cron", "list", "--all", "--json"]);
    const jobs = Array.isArray(listed)
      ? listed
      : ((listed as { jobs?: unknown[]; items?: unknown[] }).jobs ??
        (listed as { items?: unknown[] }).items ??
        []);
    const matches = jobs
      .map((job) => normalizeCronJob(job))
      .filter((job): job is NonNullable<ReturnType<typeof normalizeCronJob>> =>
        Boolean(job?.name.startsWith(namePrefix)),
      );
    await Promise.allSettled(matches.map((job) => runOpenClaw(["cron", "rm", job.id, "--json"])));
  }
});

async function showStable(jobId: string) {
  const stable = normalizeCronJob(await runOpenClawJson(["cron", "show", jobId, "--json"]));
  if (!stable) {
    throw new Error(`Unable to normalize cron job ${jobId}`);
  }
  return stable;
}

async function showEssentials(jobId: string) {
  const stable = await showStable(jobId);
  return {
    id: stable.id,
    name: stable.name,
    enabled: stable.enabled,
    cron: stable.schedule.expr,
    tz: stable.schedule.tz,
    session: stable.delivery.session,
    message: stable.delivery.message,
  };
}

async function editJobTimezone(jobId: string, targetTz: string): Promise<void> {
  const stable = await showStable(jobId);
  const args = [
    "cron",
    "edit",
    stable.id,
    "--name",
    stable.name,
    "--message",
    stable.delivery.message ?? "",
    "--session",
    stable.delivery.session ?? "",
    "--cron",
    stable.schedule.expr,
    "--tz",
    targetTz,
  ];
  args.push(stable.enabled ? "--enable" : "--disable");
  await runOpenClaw(args);
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
  let lastResult: { stdout: string; stderr: string } | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lastResult = await runOpenClaw(args);
    if (lastResult.stdout.trim()) {
      try {
        return JSON.parse(lastResult.stdout);
      } catch (error) {
        throw new Error(
          `Unable to parse OpenClaw JSON for ${args.join(" ")}: ${String(error)}; stdout=${JSON.stringify(
            lastResult.stdout.slice(0, 500),
          )}; stderr=${JSON.stringify(lastResult.stderr.slice(0, 500))}`,
        );
      }
    }
    await sleep(250 * attempt);
  }

  throw new Error(
    `OpenClaw command returned empty JSON output for ${args.join(" ")}; stdout=${JSON.stringify(
      lastResult?.stdout ?? "",
    )}; stderr=${JSON.stringify(lastResult?.stderr ?? "")}`,
  );
}

async function runOpenClaw(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(OPENCLAW_BIN, args, {
    encoding: "utf8",
    env: openClawChildEnv(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function openClawChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return env;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
