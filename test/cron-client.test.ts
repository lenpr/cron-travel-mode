import { describe, expect, it } from "vitest";
import { OpenClawCliCronClient, type CommandRunner } from "../src/cron-client.js";

describe("OpenClawCliCronClient", () => {
  it("re-passes persisted fields and enabled state when editing timezone", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}", stderr: "" };
    };
    const client = new OpenClawCliCronClient("openclaw", runner);

    await client.editJobTimezone(
      {
        id: "job-1",
        name: "Morning reminder",
        enabled: false,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Los_Angeles" },
        delivery: { session: "isolated", message: "Say hello" },
      },
      "Europe/Berlin",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "cron",
      "edit",
      "job-1",
      "--name",
      "Morning reminder",
      "--message",
      "Say hello",
      "--session",
      "isolated",
      "--cron",
      "0 9 * * *",
      "--tz",
      "Europe/Berlin",
      "--disable",
    ]);
  });

  it("refuses implicit-timezone jobs before shelling out", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const client = new OpenClawCliCronClient("openclaw", async (command, args) => {
      calls.push({ command, args });
      return { stdout: "{}", stderr: "" };
    });

    await expect(
      client.editJobTimezone(
        {
          id: "job-1",
          name: "Implicit reminder",
          enabled: true,
          schedule: { kind: "cron", expr: "0 9 * * *" },
          delivery: { session: "isolated", message: "Say hello" },
        },
        "Europe/Berlin",
      ),
    ).rejects.toMatchObject({ code: "implicit_timezone_refused" });
    expect(calls).toHaveLength(0);
  });
});
