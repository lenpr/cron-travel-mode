import { describe, expect, it } from "vitest";
import { normalizeCronJob } from "../src/hash.js";

describe("normalizeCronJob", () => {
  it("normalizes OpenClaw persisted cron shape", () => {
    const job = normalizeCronJob({
      id: "job-1",
      agentId: "main",
      name: "Morning reminder",
      enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Say hello" },
      delivery: { mode: "none", channel: "last" },
    });

    expect(job).toMatchObject({
      id: "job-1",
      agent: "main",
      enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles" },
      delivery: { session: "isolated", message: "Say hello" },
    });
  });
});
