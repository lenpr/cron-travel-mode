export const PLUGIN_ID = "cron-travel-mode";

export const TOOL_NAMES = {
  generate: "generate_travel_cron_plan",
  apply: "apply_travel_cron_plan",
  restore: "restore_travel_cron_plan",
  recover: "abort_or_recover_travel_cron",
  status: "travel_cron_status",
} as const;

export type Decision = "move" | "stay" | "needs_review";

export type TravelCronPhase =
  | "draft"
  | "committed"
  | "scheduled"
  | "applying"
  | "active"
  | "restoring"
  | "restored"
  | "cancelled"
  | "cancelled_with_skips"
  | "apply_failed_partial"
  | "restore_failed_partial"
  | "recoverable_error"
  | "missed_activation_noop";

export type ConfirmationKind =
  | "late_activation"
  | "late_restore"
  | "early_abort_restore"
  | "force_restore";

export interface TravelCronConfig {
  maxInventoryJobs: number;
  maxInventoryBytes: number;
  defaultLateRestoreThresholdHours: number;
  activationGraceMinutes: number;
  lockTtlMs: number;
}

export interface TripWindow {
  startsAt: string;
  endsAt: string;
  targetTz: string;
  lateRestoreThresholdHours: number;
  activationGraceMinutes: number;
}

export interface StableCronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: "cron";
    expr: string;
    tz?: string;
  };
  delivery: {
    session?: string;
    message?: string;
  };
  agent?: string;
  description?: string;
}

export interface SnapshotJob {
  stable: StableCronJob;
  stableHash: string;
  raw: unknown;
}

export interface DraftJobSummary {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string | null;
  editable: boolean;
  requiredDecision?: "needs_review";
  agent?: string;
  session?: string;
  delivery: {
    session?: string;
    messagePreview?: string;
  };
  descriptionPreview?: string;
  stableHash: string;
  reason?: string;
}

export interface DraftState {
  inventoryFetchedAt: string;
  inventoryHash: string;
  rawInventory: unknown;
  jobs: Record<string, SnapshotJob>;
  summaries: DraftJobSummary[];
  filters?: InventoryFilter;
}

export interface CommittedDecision {
  decision: Decision;
  reason?: string;
  stableHashAtDraft: string;
}

export interface CommittedState {
  committedAt: string;
  decisions: Record<string, CommittedDecision>;
  moveJobIds: string[];
  stayJobIds: string[];
  needsReviewJobIds: string[];
  moveSnapshot: Record<string, SnapshotJob>;
  warnings: string[];
}

export type LedgerStatus =
  | "pending"
  | "applying"
  | "applied"
  | "restoring"
  | "restored"
  | "skipped_drift"
  | "skipped_missing"
  | "failed";

export interface OperationLedgerEntry {
  jobId: string;
  operation: "apply" | "restore";
  status: LedgerStatus;
  fromTz?: string;
  toTz?: string;
  message?: string;
  updatedAt: string;
}

export interface ApplyState {
  scheduledAt?: string;
  appliedAt?: string;
  applySnapshot: Record<string, SnapshotJob>;
  ledger: OperationLedgerEntry[];
}

export interface RestoreState {
  restoredAt?: string;
  reason: "scheduled_restore" | "manual_restore" | "abort" | "recovery";
  force: boolean;
  ledger: OperationLedgerEntry[];
}

export interface ConfirmationRequest {
  operationId: string;
  kind: ConfirmationKind;
  message: string;
  createdAt: string;
  expiresAt: string;
  baseRevision: number;
}

export interface TravelCronState {
  schemaVersion: 1;
  revision: number;
  phase: TravelCronPhase;
  createdAt: string;
  updatedAt: string;
  trip?: TripWindow;
  draft?: DraftState;
  committed?: CommittedState;
  apply?: ApplyState;
  restore?: RestoreState;
  pendingConfirmation?: ConfirmationRequest;
  attentionRequired?: string;
  lastError?: string;
}

export interface InventoryFilter {
  nameIncludes?: string;
  agent?: string;
  session?: string;
}

export interface DecisionInput {
  id: string;
  decision: Decision;
  reason?: string;
}

export interface ToolBody {
  ok: boolean;
  phase?: TravelCronPhase;
  revision?: number;
  message: string;
  confirmationRequired?: boolean;
  operationId?: string;
  expiresAt?: string;
  warnings?: string[];
  [key: string]: unknown;
}

export interface CronClient {
  listJobs(): Promise<unknown[]>;
  showJob(jobId: string): Promise<unknown>;
  editJobTimezone(job: unknown, targetTz: string): Promise<void>;
}

export class TravelCronError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "TravelCronError";
    this.code = code;
    this.details = details;
  }
}
