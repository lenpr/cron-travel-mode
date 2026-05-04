import { createHash } from "node:crypto";
import type {
  DraftJobSummary,
  InventoryFilter,
  SnapshotJob,
  StableCronJob,
} from "./types.js";

const PREVIEW_LIMIT = 180;

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function normalizeCronJob(raw: unknown): StableCronJob | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const job = raw as Record<string, unknown>;
  const schedule = readObject(job.schedule);
  const delivery = readObject(job.delivery);
  const payload = readObject(job.payload);

  const id = readString(job.id) ?? readString(job.jobId);
  const expr =
    readString(schedule.expr) ??
    readString(schedule.cron) ??
    readString(job.cron);
  const kind =
    readString(schedule.kind) ??
    (expr ? "cron" : readString(job.kind));

  if (!id || kind !== "cron" || !expr) {
    return null;
  }

  const tz =
    readString(schedule.tz) ??
    readString(schedule.timezone) ??
    readString(job.tz) ??
    readString(job.timezone);

  const session =
    readString(delivery.session) ??
    readString(payload.session) ??
    readString(job.sessionTarget) ??
    readString(job.session);
  const message =
    readString(delivery.message) ??
    readString(payload.message) ??
    readString(job.message);

  const normalized: StableCronJob = {
    id,
    name: readString(job.name) ?? "",
    enabled: readBoolean(job.enabled) ?? true,
    schedule: tz ? { kind: "cron", expr, tz } : { kind: "cron", expr },
    delivery: compactRecord({ session, message }),
  };

  const agent = readString(job.agent) ?? readString(job.agentId) ?? readString(payload.agent);
  if (agent) {
    normalized.agent = agent;
  }

  const description =
    readString(job.description) ??
    readString(delivery.description) ??
    readString(payload.description);
  if (description) {
    normalized.description = description;
  }

  return normalized;
}

export function snapshotCronJob(raw: unknown): SnapshotJob | null {
  const stable = normalizeCronJob(raw);
  if (!stable) {
    return null;
  }
  return {
    stable,
    stableHash: stableCronHash(stable),
    raw,
  };
}

export function snapshotWithTimezone(snapshot: SnapshotJob, tz: string): SnapshotJob {
  const stable = withTimezone(snapshot.stable, tz);
  return {
    stable,
    stableHash: stableCronHash(stable),
    raw: rawWithTimezone(snapshot.raw, tz),
  };
}

export function stableCronHash(job: StableCronJob): string {
  return sha256(strictPersistedFields(job));
}

export function strictPersistedFields(job: StableCronJob): unknown {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    schedule: {
      kind: job.schedule.kind,
      expr: job.schedule.expr,
      tz: job.schedule.tz ?? null,
    },
    delivery: {
      session: job.delivery.session ?? null,
      message: job.delivery.message ?? null,
    },
  };
}

export function strictPersistedFieldsIgnoringTimezone(job: StableCronJob): unknown {
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    schedule: {
      kind: job.schedule.kind,
      expr: job.schedule.expr,
    },
    delivery: {
      session: job.delivery.session ?? null,
      message: job.delivery.message ?? null,
    },
  };
}

export function withTimezone(job: StableCronJob, tz: string): StableCronJob {
  return {
    ...job,
    schedule: {
      ...job.schedule,
      tz,
    },
    delivery: { ...job.delivery },
  };
}

export function samePersistedExceptTimezone(
  left: StableCronJob,
  right: StableCronJob,
): boolean {
  return (
    stableStringify(strictPersistedFieldsIgnoringTimezone(left)) ===
    stableStringify(strictPersistedFieldsIgnoringTimezone(right))
  );
}

export function toDraftSummary(snapshot: SnapshotJob): DraftJobSummary {
  const { stable } = snapshot;
  const hasExplicitTimezone = Boolean(stable.schedule.tz);
  const summary: DraftJobSummary = {
    id: stable.id,
    name: stable.name,
    enabled: stable.enabled,
    cron: stable.schedule.expr,
    timezone: stable.schedule.tz ?? null,
    editable: hasExplicitTimezone,
    delivery: {
      session: stable.delivery.session,
      messagePreview: preview(stable.delivery.message),
    },
    stableHash: snapshot.stableHash,
  };

  if (stable.agent) {
    summary.agent = stable.agent;
  }
  if (stable.delivery.session) {
    summary.session = stable.delivery.session;
  }
  if (stable.description) {
    summary.descriptionPreview = preview(stable.description);
  }
  if (!hasExplicitTimezone) {
    summary.requiredDecision = "needs_review";
    summary.reason = "No explicit schedule timezone is present; v1 will not edit this job.";
  }

  return summary;
}

export function applyInventoryFilter(
  snapshots: SnapshotJob[],
  filter?: InventoryFilter,
): SnapshotJob[] {
  if (!filter) {
    return snapshots;
  }

  const nameNeedle = filter.nameIncludes?.toLowerCase();
  return snapshots.filter(({ stable }) => {
    if (nameNeedle && !stable.name.toLowerCase().includes(nameNeedle)) {
      return false;
    }
    if (filter.agent && stable.agent !== filter.agent) {
      return false;
    }
    if (filter.session && stable.delivery.session !== filter.session) {
      return false;
    }
    return true;
  });
}

export function buildSnapshotMap(snapshots: SnapshotJob[]): Record<string, SnapshotJob> {
  return Object.fromEntries(snapshots.map((snapshot) => [snapshot.stable.id, snapshot]));
}

export function preview(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT - 3)}...` : value;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compactRecord<T extends Record<string, string | undefined>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function rawWithTimezone(raw: unknown, tz: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const cloned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const schedule = readObject(cloned.schedule);
  cloned.schedule = {
    ...schedule,
    tz,
  };
  if ("tz" in cloned) {
    cloned.tz = tz;
  }
  if ("timezone" in cloned) {
    cloned.timezone = tz;
  }
  return cloned;
}
