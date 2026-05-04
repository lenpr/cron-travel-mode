import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeCronJob } from "../src/hash.js";
import { createStatePaths, loadState } from "../src/state.js";
import { DEFAULT_CONFIG, type Clock, TravelCronService } from "../src/service.js";
import type { CronClient } from "../src/types.js";

class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(iso: string): void {
    this.value = new Date(iso);
  }
}

class FakeCronClient implements CronClient {
  readonly edits: Array<{
    id: string;
    targetTz: string;
    name: string;
    message: string;
    session: string;
    cron: string;
  }> = [];

  incompatibleEdit = false;
  failNextEdit = false;

  constructor(private jobs: Record<string, unknown>) {}

  async listJobs(): Promise<unknown[]> {
    return Object.values(this.jobs).map(clone);
  }

  async showJob(jobId: string): Promise<unknown> {
    const job = this.jobs[jobId];
    if (!job) {
      throw new Error(`missing job ${jobId}`);
    }
    return clone(job);
  }

  async editJobTimezone(job: unknown, targetTz: string): Promise<void> {
    if (this.failNextEdit) {
      this.failNextEdit = false;
      throw new Error("planned edit failure");
    }

    const stable = normalizeCronJob(job);
    if (!stable) {
      throw new Error("unsupported job");
    }
    this.edits.push({
      id: stable.id,
      targetTz,
      name: stable.name,
      message: stable.delivery.message ?? "",
      session: stable.delivery.session ?? "",
      cron: stable.schedule.expr,
    });

    const current = clone(this.jobs[stable.id]) as AnyJob;
    current.name = stable.name;
    current.delivery = {
      ...(current.delivery ?? {}),
      session: stable.delivery.session,
      message: this.incompatibleEdit ? "corrupted" : stable.delivery.message,
    };
    current.schedule = {
      ...(current.schedule ?? {}),
      kind: "cron",
      expr: stable.schedule.expr,
      tz: targetTz,
    };
    this.jobs[stable.id] = current;
  }

  mutate(jobId: string, patch: (job: AnyJob) => void): void {
    const current = clone(this.jobs[jobId]) as AnyJob;
    patch(current);
    this.jobs[jobId] = current;
  }

  timezone(jobId: string): string | undefined {
    return normalizeCronJob(this.jobs[jobId])?.schedule.tz;
  }
}

interface AnyJob {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
    at?: string;
  };
  delivery?: {
    session?: string;
    message?: string;
  };
  agent?: string;
}

let tmpDir: string;
let clock: MutableClock;
let cron: FakeCronClient;
let service: TravelCronService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-travel-mode-"));
  clock = new MutableClock(new Date("2026-05-01T08:00:00.000Z"));
  cron = new FakeCronClient({
    gratitude: cronJob("gratitude", "Gratitude reminder", "0 9 * * *", "America/Los_Angeles"),
    backup: cronJob("backup", "Backup", "0 2 * * *", "America/Los_Angeles"),
    implicit: cronJob("implicit", "Implicit reminder", "0 11 * * *", undefined),
    oneShot: {
      id: "oneShot",
      name: "One shot",
      enabled: true,
      schedule: { kind: "at", at: "2026-05-01T10:00:00Z" },
      delivery: { session: "main", message: "once" },
    },
  });
  service = new TravelCronService(
    createStatePaths(tmpDir),
    cron,
    clock,
    {
      ...DEFAULT_CONFIG,
      activationGraceMinutes: 5,
      defaultLateRestoreThresholdHours: 12,
    },
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("travel cron plan flow", () => {
  it("drafts recurring inventory and forces implicit-timezone jobs to needs_review on commit", async () => {
    const draft = await draftPlan();

    expect(draft.ok).toBe(true);
    expect((draft.jobs as unknown[]).map((job: any) => job.id)).toEqual([
      "gratitude",
      "backup",
      "implicit",
    ]);
    expect((draft.jobs as any[]).find((job) => job.id === "implicit").editable).toBe(false);

    const committed = await service.commit({
      expectedRevision: draft.revision as number,
      decisions: [
        { id: "gratitude", decision: "move" },
        { id: "backup", decision: "stay" },
        { id: "implicit", decision: "move" },
      ],
    });

    expect(committed.ok).toBe(true);
    expect(committed.moveJobIds).toEqual(["gratitude"]);
    expect(committed.needsReviewJobIds).toEqual(["implicit"]);
    expect((committed.warnings as string[])[0]).toContain("forced to needs_review");
  });

  it("rejects changed move jobs but only warns about changed stay jobs", async () => {
    const draft = await draftPlan();
    cron.mutate("gratitude", (job) => {
      job.name = "Changed gratitude";
    });

    const rejected = await service.commit({
      expectedRevision: draft.revision as number,
      decisions: [
        { id: "gratitude", decision: "move" },
        { id: "backup", decision: "stay" },
        { id: "implicit", decision: "needs_review" },
      ],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.code).toBe("move_job_changed");

    const secondDraft = await draftPlan();
    cron.mutate("backup", (job) => {
      job.name = "Changed backup";
    });
    const committed = await service.commit({
      expectedRevision: secondDraft.revision as number,
      decisions: [
        { id: "gratitude", decision: "move" },
        { id: "backup", decision: "stay" },
        { id: "implicit", decision: "needs_review" },
      ],
    });
    expect(committed.ok).toBe(true);
    expect((committed.warnings as string[])[0]).toContain("Stay job backup changed");
  });

  it("applies only moved jobs and restores them from the apply-time snapshot", async () => {
    const committed = await committedPlan();
    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });

    expect(applied.ok).toBe(true);
    expect(applied.phase).toBe("active");
    expect(cron.timezone("gratitude")).toBe("Europe/Berlin");
    expect(cron.timezone("backup")).toBe("America/Los_Angeles");
    expect(cron.edits[0]).toMatchObject({
      id: "gratitude",
      name: "Gratitude reminder",
      message: "Message for gratitude",
      session: "main",
      cron: "0 9 * * *",
      targetTz: "Europe/Berlin",
    });

    const restored = await service.restore({ expectedRevision: applied.revision as number });
    expect(restored.ok).toBe(true);
    expect(restored.phase).toBe("restored");
    expect(cron.timezone("gratitude")).toBe("America/Los_Angeles");
  });

  it("detects incompatible cron edit behavior and best-effort restores the edited job", async () => {
    const committed = await committedPlan();
    cron.incompatibleEdit = true;

    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });

    expect(applied.ok).toBe(false);
    expect(applied.phase).toBe("recoverable_error");
    expect(cron.timezone("gratitude")).toBe("America/Los_Angeles");
    expect(applied.upgradeInstruction).toContain("Upgrade OpenClaw");
  });

  it("uses expiring confirmation for late activation during the trip", async () => {
    const committed = await committedPlan();
    const scheduled = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "scheduled",
    });
    expect(scheduled.phase).toBe("scheduled");

    clock.set("2026-05-02T08:10:00.000Z");
    const status = await service.status();
    expect(status.confirmationRequired).toBeUndefined();
    expect((status.pendingConfirmation as any).kind).toBe("late_activation");

    const operationId = (status.pendingConfirmation as any).operationId as string;
    const applied = await service.apply({ confirmOperationId: operationId });
    expect(applied.ok).toBe(true);
    expect(applied.phase).toBe("active");
    expect(cron.timezone("gratitude")).toBe("Europe/Berlin");
  });

  it("marks missed activation as noop when the next tool call occurs after trip end", async () => {
    const committed = await committedPlan();
    await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "scheduled",
    });

    clock.set("2026-05-06T09:00:00.000Z");
    const status = await service.status();
    expect(status.phase).toBe("missed_activation_noop");
    expect(cron.timezone("gratitude")).toBe("America/Los_Angeles");
  });

  it("requires confirmation for late restore beyond the configured threshold", async () => {
    const committed = await committedPlan();
    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });
    expect(applied.phase).toBe("active");

    clock.set("2026-05-06T21:00:00.000Z");
    const status = await service.status();
    const pending = status.pendingConfirmation as any;
    expect(pending.kind).toBe("late_restore");
    expect(cron.timezone("gratitude")).toBe("Europe/Berlin");

    const restored = await service.restore({ confirmOperationId: pending.operationId });
    expect(restored.phase).toBe("restored");
    expect(cron.timezone("gratitude")).toBe("America/Los_Angeles");
  });

  it("requires confirmation before early active abort restore", async () => {
    const committed = await committedPlan();
    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });
    expect(applied.phase).toBe("active");

    const abort = await service.recover({
      expectedRevision: applied.revision as number,
      action: "abort",
    });
    expect(abort.confirmationRequired).toBe(true);
    expect(cron.timezone("gratitude")).toBe("Europe/Berlin");

    const confirmed = await service.recover({
      action: "abort",
      confirmOperationId: abort.operationId as string,
    });
    expect(confirmed.phase).toBe("cancelled");
    expect(cron.timezone("gratitude")).toBe("America/Los_Angeles");
  });

  it("skips drifted moved jobs unless force is confirmed", async () => {
    const committed = await committedPlan();
    const applied = await service.apply({
      expectedRevision: committed.revision as number,
      activationMode: "now",
    });
    cron.mutate("gratitude", (job) => {
      job.delivery = { ...(job.delivery ?? {}), message: "Manually changed" };
    });

    const restored = await service.restore({ expectedRevision: applied.revision as number });
    expect(restored.ok).toBe(false);
    expect(restored.phase).toBe("restore_failed_partial");
    expect(restored.skippedJobIds).toEqual(["gratitude"]);

    const forcedRequest = await service.restore({
      expectedRevision: restored.revision as number,
      force: true,
    });
    expect(forcedRequest.confirmationRequired).toBe(true);
    const forced = await service.restore({
      force: true,
      confirmOperationId: forcedRequest.operationId as string,
    });
    expect(forced.phase).toBe("restored");
    expect(cron.timezone("gratitude")).toBe("America/Los_Angeles");
  });

  it("rejects stale revisions on mutating tools", async () => {
    const draft = await draftPlan();
    const first = await service.commit({
      expectedRevision: draft.revision as number,
      decisions: [
        { id: "gratitude", decision: "move" },
        { id: "backup", decision: "stay" },
        { id: "implicit", decision: "needs_review" },
      ],
    });
    expect(first.ok).toBe(true);

    const stale = await service.apply({
      expectedRevision: draft.revision as number,
      activationMode: "now",
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("revision_conflict");
  });

  it("recovers cleanly from stale lock files", async () => {
    const paths = createStatePaths(tmpDir);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(
      paths.lock,
      JSON.stringify({
        ownerId: "old",
        operation: "old",
        createdAt: "2026-05-01T00:00:00.000Z",
        expiresAt: "2026-05-01T00:00:01.000Z",
      }),
    );

    const status = await service.status();
    expect(status.ok).toBe(true);
    expect(fs.existsSync(paths.lock)).toBe(false);
  });
});

async function draftPlan() {
  return service.draft({
    startsAt: "2026-05-02T08:00:00.000Z",
    endsAt: "2026-05-06T08:00:00.000Z",
    targetTz: "Europe/Berlin",
  });
}

async function committedPlan() {
  const draft = await draftPlan();
  return service.commit({
    expectedRevision: draft.revision as number,
    decisions: [
      { id: "gratitude", decision: "move" },
      { id: "backup", decision: "stay" },
      { id: "implicit", decision: "needs_review" },
    ],
  });
}

function cronJob(
  id: string,
  name: string,
  expr: string,
  tz: string | undefined,
): AnyJob {
  return {
    id,
    name,
    enabled: true,
    schedule: tz ? { kind: "cron", expr, tz } : { kind: "cron", expr },
    delivery: {
      session: "main",
      message: `Message for ${id}`,
    },
    agent: "main",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
