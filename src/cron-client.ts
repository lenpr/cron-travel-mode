import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeCronJob } from "./hash.js";
import type { CronClient } from "./types.js";
import { TravelCronError } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CommandRunner {
  (command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export class OpenClawCliCronClient implements CronClient {
  constructor(
    private readonly command = "openclaw",
    private readonly run: CommandRunner = defaultRunner,
  ) {}

  async listJobs(): Promise<unknown[]> {
    const output = await this.runJson(["cron", "list", "--json"]);
    return unwrapJobs(output);
  }

  async showJob(jobId: string): Promise<unknown> {
    return this.runJson(["cron", "show", jobId, "--json"]);
  }

  async editJobTimezone(job: unknown, targetTz: string): Promise<void> {
    const stable = normalizeCronJob(job);
    if (!stable) {
      throw new TravelCronError(
        "unsupported_cron_job",
        "Cron job is missing an id or cron schedule and cannot be edited.",
        job,
      );
    }
    if (!stable.schedule.tz) {
      throw new TravelCronError(
        "implicit_timezone_refused",
        `Cron job ${stable.id} has no explicit timezone and cannot be edited by travel mode.`,
      );
    }

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

    try {
      await this.run(this.command, args);
    } catch (error) {
      throw new TravelCronError(
        "cron_edit_failed",
        "OpenClaw cron edit failed. Upgrade OpenClaw to a version that supports `openclaw cron edit <jobId> --cron <expr> --tz <iana>` with name, message, and session preservation.",
        error,
      );
    }
  }

  private async runJson(args: string[]): Promise<unknown> {
    const { stdout } = await this.run(this.command, args);
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new TravelCronError(
        "cron_json_parse_failed",
        `Unable to parse JSON from \`${this.command} ${args.join(" ")}\`.`,
        { error, stdout },
      );
    }
  }
}

async function defaultRunner(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function unwrapJobs(output: unknown): unknown[] {
  if (Array.isArray(output)) {
    return output;
  }
  if (output && typeof output === "object") {
    const object = output as Record<string, unknown>;
    if (Array.isArray(object.jobs)) {
      return object.jobs;
    }
    if (Array.isArray(object.items)) {
      return object.items;
    }
  }
  throw new TravelCronError(
    "cron_list_shape_unsupported",
    "OpenClaw cron list JSON did not return an array or a jobs/items array.",
    output,
  );
}
