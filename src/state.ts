import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TravelCronState } from "./types.js";
import { TravelCronError } from "./types.js";

export const STATE_SUBDIR = "cron-travel-mode";
export const STATE_FILE = "current_travel_cron_plan.json";
export const LOCK_FILE = "current_travel_cron_plan.lock";

export interface StatePaths {
  dir: string;
  file: string;
  lock: string;
}

export interface LockInfo {
  ownerId: string;
  operation: string;
  expiresAt: string;
  createdAt: string;
}

export function createStatePaths(baseStateDir: string): StatePaths {
  const dir = path.join(baseStateDir, STATE_SUBDIR);
  return {
    dir,
    file: path.join(dir, STATE_FILE),
    lock: path.join(dir, LOCK_FILE),
  };
}

export function ensureStateDir(paths: StatePaths): void {
  fs.mkdirSync(paths.dir, { recursive: true });
}

export function loadState(paths: StatePaths): TravelCronState | null {
  if (!fs.existsSync(paths.file)) {
    return null;
  }

  const text = fs.readFileSync(paths.file, "utf8");
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text) as TravelCronState;
}

export function writeState(
  paths: StatePaths,
  state: TravelCronState,
  nowIso: string,
): TravelCronState {
  ensureStateDir(paths);
  const next: TravelCronState = {
    ...state,
    revision: state.revision + 1,
    updatedAt: nowIso,
  };
  const tempPath = path.join(
    paths.dir,
    `${STATE_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, paths.file);
  return next;
}

export function clearStaleLock(paths: StatePaths, nowMs: number): boolean {
  const lock = readLock(paths);
  if (!lock) {
    return false;
  }
  if (Date.parse(lock.expiresAt) > nowMs) {
    return false;
  }
  try {
    fs.unlinkSync(paths.lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function readLock(paths: StatePaths): LockInfo | null {
  if (!fs.existsSync(paths.lock)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(paths.lock, "utf8")) as LockInfo;
  } catch {
    return {
      ownerId: "unknown",
      operation: "unknown",
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
    };
  }
}

export async function withStateLock<T>(
  paths: StatePaths,
  operation: string,
  lockTtlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  ensureStateDir(paths);
  const ownerId = randomUUID();
  const nowMs = Date.now();
  clearStaleLock(paths, nowMs);

  const lock: LockInfo = {
    ownerId,
    operation,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + lockTtlMs).toISOString(),
  };

  let fd: number | null = null;
  try {
    try {
      fd = fs.openSync(paths.lock, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(lock, null, 2), "utf8");
      fs.closeSync(fd);
      fd = null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const currentLock = readLock(paths);
      throw new TravelCronError(
        "state_locked",
        `Cron travel state is locked by ${currentLock?.operation ?? "another operation"} until ${
          currentLock?.expiresAt ?? "unknown"
        }.`,
        currentLock,
      );
    }

    return await fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
    const current = readLock(paths);
    if (current?.ownerId === ownerId) {
      try {
        fs.unlinkSync(paths.lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

export function assertExpectedRevision(
  state: TravelCronState | null,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) {
    return;
  }
  const actual = state?.revision ?? 0;
  if (actual !== expectedRevision) {
    throw new TravelCronError(
      "revision_conflict",
      `State revision changed from ${expectedRevision} to ${actual}; refresh status and retry.`,
      { expectedRevision, actual },
    );
  }
}

export function makeInitialState(
  phase: TravelCronState["phase"],
  nowIso: string,
): TravelCronState {
  return {
    schemaVersion: 1,
    revision: 0,
    phase,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
