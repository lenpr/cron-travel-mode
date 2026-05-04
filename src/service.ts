import { randomUUID } from "node:crypto";
import {
  applyInventoryFilter,
  buildSnapshotMap,
  normalizeCronJob,
  samePersistedExceptTimezone,
  sha256,
  snapshotCronJob,
  snapshotWithTimezone,
  stableStringify,
  strictPersistedFields,
  toDraftSummary,
  withTimezone,
} from "./hash.js";
import {
  assertExpectedRevision,
  clearStaleLock,
  loadState,
  makeInitialState,
  readLock,
  type StatePaths,
  withStateLock,
  writeState,
} from "./state.js";
import type {
  AdoptedJobInput,
  ConfirmationKind,
  CronClient,
  Decision,
  DecisionInput,
  DraftJobSummary,
  InventoryFilter,
  OperationLedgerEntry,
  SnapshotJob,
  ToolBody,
  TravelCronConfig,
  TravelCronPhase,
  TravelCronState,
  TripWindow,
} from "./types.js";
import { TravelCronError } from "./types.js";

// Centralized state machine for all mutating tools. Keeping the phase transitions
// together makes revision checks, confirmations, and recovery behavior auditable.
const TERMINAL_PHASES = new Set<TravelCronPhase>([
  "restored",
  "cancelled",
  "cancelled_with_skips",
  "missed_activation_noop",
]);

const BLOCKING_DRAFT_PHASES = new Set<TravelCronPhase>([
  "committed",
  "scheduled",
  "applying",
  "active",
  "restoring",
  "apply_failed_partial",
  "restore_failed_partial",
  "recoverable_error",
]);

export const DEFAULT_CONFIG: TravelCronConfig = {
  maxInventoryJobs: 200,
  maxInventoryBytes: 80 * 1024,
  defaultLateRestoreThresholdHours: 12,
  activationGraceMinutes: 5,
  lockTtlMs: 15 * 60 * 1000,
};

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface GenerateDraftParams {
  startsAt: string;
  endsAt: string;
  targetTz: string;
  expectedRevision?: number;
  filter?: InventoryFilter;
  lateRestoreThresholdHours?: number;
  activationGraceMinutes?: number;
  maxInventoryJobs?: number;
  maxInventoryBytes?: number;
}

export interface CommitPlanParams {
  expectedRevision: number;
  decisions: DecisionInput[];
}

export interface AdoptActivePlanParams {
  startsAt: string;
  endsAt: string;
  targetTz: string;
  movedJobs: AdoptedJobInput[];
  expectedRevision?: number;
  source?: string;
  lateRestoreThresholdHours?: number;
  activationGraceMinutes?: number;
}

export interface ApplyPlanParams {
  expectedRevision?: number;
  activationMode?: "now" | "scheduled";
  confirmOperationId?: string;
}

export interface RestorePlanParams {
  expectedRevision?: number;
  force?: boolean;
  confirmOperationId?: string;
}

export interface RecoverPlanParams {
  expectedRevision?: number;
  action?: "cancel" | "abort" | "recover";
  force?: boolean;
  confirmOperationId?: string;
}

export interface DoctorRuntimeInfo {
  entrypointPath?: string;
  packageRoot?: string;
  registeredTools?: string[];
}

export class TravelCronService {
  constructor(
    private readonly paths: StatePaths,
    private readonly cron: CronClient,
    private readonly clock: Clock = new SystemClock(),
    private readonly config: TravelCronConfig = DEFAULT_CONFIG,
  ) {}

  async draft(params: GenerateDraftParams): Promise<ToolBody> {
    return this.mutate("draft", async () => {
      let state = await this.reconcileLoaded(loadState(this.paths));
      assertExpectedRevision(state, params.expectedRevision);
      if (state && BLOCKING_DRAFT_PHASES.has(state.phase)) {
        throw new TravelCronError(
          "single_plan_active",
          `Cannot draft a new travel cron plan while the current plan is ${state.phase}. Restore, cancel, or recover it first.`,
          { phase: state.phase, revision: state.revision },
        );
      }

      const nowIso = this.nowIso();
      const trip = buildTripWindow(params, this.config);
      validateTripWindow(trip);

      const rawInventory = await this.cron.listJobs();
      const snapshots = rawInventory
        .map((job) => snapshotCronJob(job))
        .filter((snapshot): snapshot is SnapshotJob => snapshot !== null);
      const filtered = applyInventoryFilter(snapshots, params.filter);
      const summaries = filtered.map(toDraftSummary);
      const maxJobs = params.maxInventoryJobs ?? this.config.maxInventoryJobs;
      const maxBytes = params.maxInventoryBytes ?? this.config.maxInventoryBytes;
      const compactBytes = Buffer.byteLength(JSON.stringify(summaries), "utf8");

      if (summaries.length > maxJobs || compactBytes > maxBytes) {
        return {
          ok: false,
          message:
            "Cron inventory is too large for one safe classification pass. Filter by name, agent, or session and draft again.",
          filterRequired: true,
          recurringCronJobs: summaries.length,
          compactBytes,
          maxInventoryJobs: maxJobs,
          maxInventoryBytes: maxBytes,
          suggestedFilters: suggestFilters(summaries),
        };
      }

      const baseState =
        state && TERMINAL_PHASES.has(state.phase)
          ? { ...makeInitialState("draft", nowIso), revision: state.revision }
          : state ?? makeInitialState("draft", nowIso);
      const nextState: TravelCronState = {
        ...baseState,
        phase: "draft",
        trip,
        draft: {
          inventoryFetchedAt: nowIso,
          inventoryHash: sha256(rawInventory),
          rawInventory,
          jobs: buildSnapshotMap(filtered),
          summaries,
          filters: params.filter,
        },
        committed: undefined,
        apply: undefined,
        restore: undefined,
        pendingConfirmation: undefined,
        attentionRequired: undefined,
        lastError: undefined,
      };
      state = this.save(nextState);

      return {
        ok: true,
        phase: state.phase,
        revision: state.revision,
        message:
          "Draft created. Review the compact inventory and commit move, stay, or needs_review decisions.",
        trip,
        jobs: summaries,
      };
    });
  }

  async commit(params: CommitPlanParams): Promise<ToolBody> {
    return this.mutate("commit", async () => {
      let state = await this.reconcileLoaded(loadState(this.paths));
      assertExpectedRevision(state, params.expectedRevision);
      requirePhase(state, "draft");
      const draft = state.draft;
      if (!draft) {
        throw new TravelCronError("missing_draft", "No draft inventory is stored.");
      }

      const decisions = normalizeDecisions(params.decisions, draft.summaries);
      const warnings: string[] = [];
      for (const summary of draft.summaries) {
        const decision = decisions.get(summary.id);
        if (!decision) {
          throw new TravelCronError(
            "missing_decision",
            `Missing decision for cron job ${summary.id}.`,
          );
        }
        if (!summary.editable && decision.decision !== "needs_review") {
          warnings.push(
            `Cron job ${summary.id} has no explicit timezone; decision was forced to needs_review.`,
          );
          decision.decision = "needs_review";
        }
      }

      const currentById = await this.refetchSnapshotMap();
      const moveJobIds: string[] = [];
      const stayJobIds: string[] = [];
      const needsReviewJobIds: string[] = [];
      const moveSnapshot: Record<string, SnapshotJob> = {};
      const committedDecisions: Record<string, { decision: Decision; reason?: string; stableHashAtDraft: string }> =
        {};

      for (const summary of draft.summaries) {
        const decision = decisions.get(summary.id);
        if (!decision) {
          continue;
        }
        const draftSnapshot = draft.jobs[summary.id];
        if (!draftSnapshot) {
          throw new TravelCronError("missing_draft_snapshot", `Missing draft snapshot for ${summary.id}.`);
        }

        const current = currentById[summary.id];
        if (decision.decision === "move") {
          if (!current) {
            throw new TravelCronError(
              "move_job_disappeared",
              `Approved move job ${summary.id} no longer exists.`,
            );
          }
          if (current.stableHash !== draftSnapshot.stableHash) {
            throw new TravelCronError(
              "move_job_changed",
              `Approved move job ${summary.id} changed during review; draft again before applying.`,
              { jobId: summary.id },
            );
          }
          moveJobIds.push(summary.id);
          moveSnapshot[summary.id] = current;
        } else if (decision.decision === "stay") {
          stayJobIds.push(summary.id);
          if (current && current.stableHash !== draftSnapshot.stableHash) {
            warnings.push(
              `Stay job ${summary.id} changed during review. It will not be touched or restored by this plan.`,
            );
          }
        } else {
          needsReviewJobIds.push(summary.id);
        }

        committedDecisions[summary.id] = {
          decision: decision.decision,
          reason: decision.reason,
          stableHashAtDraft: draftSnapshot.stableHash,
        };
      }

      state.phase = "committed";
      state.committed = {
        committedAt: this.nowIso(),
        decisions: committedDecisions,
        moveJobIds,
        stayJobIds,
        needsReviewJobIds,
        moveSnapshot,
        warnings,
      };
      state.pendingConfirmation = undefined;
      state.attentionRequired = undefined;
      state = this.save(state);

      return {
        ok: true,
        phase: state.phase,
        revision: state.revision,
        message: `Plan committed with ${moveJobIds.length} move job(s), ${stayJobIds.length} stay job(s), and ${needsReviewJobIds.length} needs_review job(s).`,
        moveJobIds,
        stayJobIds,
        needsReviewJobIds,
        warnings,
      };
    });
  }

  async adoptActive(params: AdoptActivePlanParams): Promise<ToolBody> {
    return this.mutate("adopt", async () => {
      let state = await this.reconcileLoaded(loadState(this.paths));
      assertExpectedRevision(state, params.expectedRevision);
      if (state && !TERMINAL_PHASES.has(state.phase)) {
        throw new TravelCronError(
          "single_plan_active",
          `Cannot adopt an active travel cron plan while the current plan is ${state.phase}. Restore, cancel, or recover it first.`,
          { phase: state.phase, revision: state.revision },
        );
      }

      const trip = buildTripWindow(params, this.config);
      validateTripWindow(trip);
      const movedJobs = normalizeAdoptedJobs(params.movedJobs);
      const currentById = await this.refetchSnapshotMap();
      const nowIso = this.nowIso();

      const decisions: Record<string, { decision: Decision; reason?: string; stableHashAtDraft: string }> = {};
      const moveSnapshot: Record<string, SnapshotJob> = {};
      const applySnapshot: Record<string, SnapshotJob> = {};
      const ledger: OperationLedgerEntry[] = [];
      const warnings: string[] = [
        "This plan was adopted from an already-shifted live cron state; restore snapshots were synthesized from current persisted fields plus the supplied original timezone.",
      ];

      for (const movedJob of movedJobs) {
        validateIanaTimezone(movedJob.originalTz, `originalTz for ${movedJob.id}`);
        if (movedJob.originalTz === trip.targetTz) {
          throw new TravelCronError(
            "adopt_no_timezone_change",
            `Adopted job ${movedJob.id} has the same original timezone as targetTz.`,
            { jobId: movedJob.id, timezone: movedJob.originalTz },
          );
        }

        const current = currentById[movedJob.id];
        if (!current) {
          throw new TravelCronError(
            "adopt_job_missing",
            `Adopted job ${movedJob.id} does not exist in OpenClaw cron.`,
            { jobId: movedJob.id },
          );
        }
        if (!current.stable.schedule.tz) {
          throw new TravelCronError(
            "adopt_implicit_timezone_refused",
            `Adopted job ${movedJob.id} has no explicit current timezone.`,
            { jobId: movedJob.id },
          );
        }
        if (current.stable.schedule.tz !== trip.targetTz) {
          throw new TravelCronError(
            "adopt_target_timezone_mismatch",
            `Adopted job ${movedJob.id} is currently in ${current.stable.schedule.tz}, not targetTz ${trip.targetTz}.`,
            {
              jobId: movedJob.id,
              currentTz: current.stable.schedule.tz,
              targetTz: trip.targetTz,
            },
          );
        }

        const original = snapshotWithTimezone(current, movedJob.originalTz);
        moveSnapshot[movedJob.id] = original;
        applySnapshot[movedJob.id] = original;
        decisions[movedJob.id] = {
          decision: "move",
          reason: movedJob.reason,
          stableHashAtDraft: original.stableHash,
        };
        ledger.push({
          jobId: movedJob.id,
          operation: "apply",
          status: "applied",
          fromTz: movedJob.originalTz,
          toTz: trip.targetTz,
          message: "Adopted from live travel-shifted cron state.",
          updatedAt: nowIso,
        });
      }

      const baseState =
        state && TERMINAL_PHASES.has(state.phase)
          ? { ...makeInitialState("active", nowIso), revision: state.revision }
          : makeInitialState("active", nowIso);
      state = this.save({
        ...baseState,
        phase: "active",
        trip,
        draft: undefined,
        committed: {
          committedAt: nowIso,
          decisions,
          moveJobIds: movedJobs.map((job) => job.id),
          stayJobIds: [],
          needsReviewJobIds: [],
          moveSnapshot,
          warnings,
        },
        apply: {
          appliedAt: nowIso,
          applySnapshot,
          ledger,
        },
        restore: undefined,
        adoption: {
          adoptedAt: nowIso,
          source: params.source,
          jobIds: movedJobs.map((job) => job.id),
          warnings,
        },
        pendingConfirmation: undefined,
        attentionRequired: undefined,
        lastError: undefined,
      });

      return {
        ok: true,
        phase: state.phase,
        revision: state.revision,
        message:
          "Adopted the active travel cron state. Cron was not edited; moved jobs are now plugin-owned for safe restore.",
        adoptedJobIds: movedJobs.map((job) => job.id),
        restoreDueAt: trip.endsAt,
        warnings,
        safestNextAction: "travel_cron_status",
      };
    });
  }

  async apply(params: ApplyPlanParams): Promise<ToolBody> {
    return this.mutate("apply", async () => {
      let state = await this.reconcileLoaded(loadState(this.paths), params.confirmOperationId);
      requireExpectedRevisionUnlessConfirmed(params.expectedRevision, params.confirmOperationId);
      assertExpectedRevision(state, params.expectedRevision);
      requireExistingState(state);

      const confirmedLateActivation = Boolean(params.confirmOperationId);
      if (params.confirmOperationId) {
        this.consumeConfirmation(state, "late_activation", params.confirmOperationId);
      }

      if (state.phase === "scheduled") {
        const confirmation = confirmedLateActivation
          ? null
          : this.lateActivationConfirmationIfNeeded(state);
        if (confirmation) {
          state = this.save(confirmation.state);
          return confirmation.body(state);
        }
        return this.applyLocked(state, "scheduled activation");
      }

      requirePhase(state, "committed");
      const trip = requireTrip(state);
      const nowMs = this.nowMs();
      const endsAtMs = Date.parse(trip.endsAt);
      if (nowMs >= endsAtMs) {
        state.phase = "missed_activation_noop";
        state.attentionRequired =
          "Trip end has already passed, so travel cron activation was skipped.";
        state = this.save(state);
        return {
          ok: false,
          phase: state.phase,
          revision: state.revision,
          message: "Trip end has already passed; activation was skipped.",
        };
      }

      if ((params.activationMode ?? "now") === "scheduled" && nowMs < Date.parse(trip.startsAt)) {
        state.phase = "scheduled";
        state.apply = {
          scheduledAt: this.nowIso(),
          applySnapshot: {},
          ledger: [],
        };
        state = this.save(state);
        return {
          ok: true,
          phase: state.phase,
          revision: state.revision,
          message: `Plan scheduled. It will activate passively when a tool call occurs at or after ${trip.startsAt}.`,
          startsAt: trip.startsAt,
          endsAt: trip.endsAt,
        };
      }

      if ((params.activationMode ?? "now") === "scheduled") {
        const confirmation = this.lateActivationConfirmationIfNeeded(state);
        if (confirmation) {
          state = this.save(confirmation.state);
          return confirmation.body(state);
        }
      }

      return this.applyLocked(state, "manual apply");
    });
  }

  async restore(params: RestorePlanParams): Promise<ToolBody> {
    return this.mutate("restore", async () => {
      let state = await this.reconcileLoaded(loadState(this.paths), params.confirmOperationId);
      requireExpectedRevisionUnlessConfirmed(params.expectedRevision, params.confirmOperationId);
      assertExpectedRevision(state, params.expectedRevision);
      requireExistingState(state);

      if (params.confirmOperationId) {
        const expectedKind: ConfirmationKind = params.force ? "force_restore" : "late_restore";
        this.consumeConfirmation(state, expectedKind, params.confirmOperationId);
      } else if (params.force) {
        state = this.createConfirmation(
          state,
          "force_restore",
          "Force restore can overwrite manual changes to moved cron jobs. Confirm within 15 minutes to proceed.",
        );
        state = this.save(state);
        return confirmationBody(state);
      }

      if (state.phase === "active") {
        const late = this.lateRestoreConfirmationIfNeeded(state);
        if (late && !params.confirmOperationId) {
          state = this.save(late.state);
          return late.body(state);
        }
      }

      return this.restoreLocked(state, {
        force: params.force ?? false,
        reason: "manual_restore",
        successPhase: "restored",
        skippedPhase: "restore_failed_partial",
      });
    });
  }

  async recover(params: RecoverPlanParams): Promise<ToolBody> {
    return this.mutate("recover", async () => {
      let state = await this.reconcileLoaded(loadState(this.paths), params.confirmOperationId);
      requireExpectedRevisionUnlessConfirmed(params.expectedRevision, params.confirmOperationId);
      assertExpectedRevision(state, params.expectedRevision);
      requireExistingState(state);

      const action = params.action ?? "recover";
      if (action === "cancel") {
        if (state.phase === "active") {
          throw new TravelCronError(
            "use_abort_for_active_trip",
            "Use action=abort for an active trip so the timezone restore warning is explicit.",
          );
        }
        if (state.phase === "restoring" || state.phase === "apply_failed_partial") {
          throw new TravelCronError(
            "cannot_cancel_partial_state",
            "This plan is partially applied/restored; use action=recover.",
          );
        }
        state.phase = "cancelled";
        state.attentionRequired = undefined;
        state.pendingConfirmation = undefined;
        state = this.save(state);
        return {
          ok: true,
          phase: state.phase,
          revision: state.revision,
          message: "Plan cancelled. No moved jobs were restored because the trip was not active.",
        };
      }

      if (action === "abort") {
        if (!params.confirmOperationId && state.phase === "active") {
          state = this.createConfirmation(
            state,
            "early_abort_restore",
            "Aborting an active trip immediately restores moved cron jobs to their original timezones. Confirm within 15 minutes to proceed.",
          );
          state = this.save(state);
          return confirmationBody(state);
        }
        if (params.confirmOperationId) {
          this.consumeConfirmation(state, "early_abort_restore", params.confirmOperationId);
        }
        return this.restoreLocked(state, {
          force: params.force ?? false,
          reason: "abort",
          successPhase: "cancelled",
          skippedPhase: "cancelled_with_skips",
        });
      }

      if (params.force && !params.confirmOperationId) {
        state = this.createConfirmation(
          state,
          "force_restore",
          "Force recovery can overwrite manual changes to moved cron jobs. Confirm within 15 minutes to proceed.",
        );
        state = this.save(state);
        return confirmationBody(state);
      }
      if (params.confirmOperationId) {
        this.consumeConfirmation(state, params.force ? "force_restore" : "late_restore", params.confirmOperationId);
      }

      return this.restoreLocked(state, {
        force: params.force ?? false,
        reason: "recovery",
        successPhase: "restored",
        skippedPhase: "restore_failed_partial",
      });
    });
  }

  async status(): Promise<ToolBody> {
    return this.mutate("status", async () => {
      clearStaleLock(this.paths, this.nowMs());
      const state = await this.reconcileLoaded(loadState(this.paths));
      if (!state) {
        return {
          ok: true,
          message: "No travel cron plan exists. The safest next action is to draft a plan.",
          safestNextAction: "generate_travel_cron_plan?action=draft",
        };
      }

      const drift = await this.computeDrift(state);
      return {
        ok: true,
        phase: state.phase,
        revision: state.revision,
        message: statusMessage(state),
        attentionRequired: state.attentionRequired,
        pendingConfirmation: state.pendingConfirmation
          ? {
              kind: state.pendingConfirmation.kind,
              operationId: state.pendingConfirmation.operationId,
              expiresAt: state.pendingConfirmation.expiresAt,
              message: state.pendingConfirmation.message,
            }
          : undefined,
        drift,
        safestNextAction: safestNextAction(state),
      };
    });
  }

  async doctor(runtimeInfo: DoctorRuntimeInfo = {}): Promise<ToolBody> {
    return this.mutate("doctor", async () => {
      const staleLockCleared = clearStaleLock(this.paths, this.nowMs());
      const state = await this.reconcileLoaded(loadState(this.paths));
      const lock = readLock(this.paths);
      const cronCheck = await this.checkCronInventory();
      const legacyHelperJobs = cronCheck.ok ? findLegacyHelperJobs(cronCheck.jobs) : [];
      const pluginOwnedMovedJobs = summarizePluginOwnedMovedJobs(state);
      const drift = state ? await this.computeDrift(state) : { checked: false, reason: "No plan state." };
      const hasIssues =
        !cronCheck.ok ||
        legacyHelperJobs.length > 0 ||
        Boolean(state?.attentionRequired) ||
        (isDriftResult(drift) && (drift.drifted.length > 0 || drift.missing.length > 0));

      return {
        ok: !hasIssues,
        phase: state?.phase,
        revision: state?.revision,
        message: hasIssues
          ? "Travel cron doctor found items that need review."
          : "Travel cron doctor did not find install or ownership issues.",
        checks: {
          plugin: {
            entrypointPath: runtimeInfo.entrypointPath,
            packageRoot: runtimeInfo.packageRoot,
          },
          tools: {
            thisToolCallable: true,
            registeredTools: runtimeInfo.registeredTools ?? [],
            allowListVisibility:
              "OpenClaw does not expose the full host tools.allow list to plugin code. This successful doctor call proves travel_cron_doctor is callable; verify the full cron-travel-mode allow-list with the documented CLI command.",
          },
          state: {
            dir: this.paths.dir,
            file: this.paths.file,
            lock: this.paths.lock,
            hasState: Boolean(state),
            phase: state?.phase,
            attentionRequired: state?.attentionRequired,
            staleLockCleared,
            currentToolLock: lock
              ? {
                  operation: lock.operation,
                  expiresAt: lock.expiresAt,
                  note: "The doctor tool holds this advisory lock while the check is running.",
                }
              : undefined,
          },
          cron: {
            listOk: cronCheck.ok,
            error: cronCheck.ok ? undefined : cronCheck.message,
            legacyHelperJobs,
          },
          ownership: {
            pluginOwnedMovedJobs,
            liveMovedJobsPluginOwned:
              pluginOwnedMovedJobs.length > 0
                ? "Known moved jobs are represented in plugin state."
                : "No plugin-owned moved jobs are recorded. If jobs are already travel-shifted, use adopt_active_travel_cron_plan with an original-timezone manifest.",
            drift,
          },
        },
        safestNextAction: hasIssues && state ? safestNextAction(state) : "No action needed.",
      };
    });
  }

  private async reconcileLoaded(
    state: TravelCronState | null,
    confirmOperationId?: string,
  ): Promise<TravelCronState | null> {
    if (!state) {
      return null;
    }

    const nowMs = this.nowMs();
    if (state.pendingConfirmation && Date.parse(state.pendingConfirmation.expiresAt) <= nowMs) {
      state.pendingConfirmation = undefined;
      state.attentionRequired = "A pending confirmation expired. Refresh status and request the action again.";
      state = this.save(state);
    }

    if (confirmOperationId) {
      return state;
    }

    if (state.phase === "scheduled") {
      const trip = requireTrip(state);
      if (nowMs >= Date.parse(trip.endsAt)) {
        state.phase = "missed_activation_noop";
        state.attentionRequired =
          "Trip end has already passed, so travel cron activation was skipped.";
        return this.save(state);
      }

      if (nowMs >= Date.parse(trip.startsAt)) {
        const late = this.lateActivationConfirmationIfNeeded(state);
        if (late) {
          return this.save(late.state);
        }
        await this.applyLocked(state, "passive scheduled activation");
        return loadState(this.paths);
      }
    }

    if (state.phase === "active" && nowMs >= Date.parse(requireTrip(state).endsAt)) {
      const late = this.lateRestoreConfirmationIfNeeded(state);
      if (late) {
        return this.save(late.state);
      }
      const body = await this.restoreLocked(state, {
        force: false,
        reason: "scheduled_restore",
        successPhase: "restored",
        skippedPhase: "restore_failed_partial",
      });
      return loadState(this.paths) ?? stateFromBodyFallback(state, body);
    }

    return state;
  }

  private async applyLocked(
    state: TravelCronState,
    reason: string,
  ): Promise<ToolBody> {
    requirePhaseOneOf(state, ["committed", "scheduled"]);
    const trip = requireTrip(state);
    const committed = requireCommitted(state);
    const currentById = await this.refetchSnapshotMap();

    const applySnapshot: Record<string, SnapshotJob> = {};
    for (const jobId of committed.moveJobIds) {
      const current = currentById[jobId];
      const committedSnapshot = committed.moveSnapshot[jobId];
      if (!current || !committedSnapshot) {
        throw new TravelCronError(
          "move_job_disappeared",
          `Approved move job ${jobId} no longer exists.`,
        );
      }
      if (current.stableHash !== committedSnapshot.stableHash) {
        throw new TravelCronError(
          "move_job_changed_before_apply",
          `Approved move job ${jobId} changed after commit; draft again before applying.`,
          { jobId },
        );
      }
      if (!current.stable.schedule.tz) {
        throw new TravelCronError(
          "implicit_timezone_refused",
          `Approved move job ${jobId} no longer has an explicit timezone.`,
        );
      }
      applySnapshot[jobId] = current;
    }

    state.phase = "applying";
    state.apply = {
      ...(state.apply ?? {}),
      applySnapshot,
      ledger: [],
    };
    state.pendingConfirmation = undefined;
    state.attentionRequired = undefined;
    state = this.save(state);

    const appliedIds: string[] = [];
    for (const jobId of committed.moveJobIds) {
      const snapshot = applySnapshot[jobId];
      if (!snapshot) {
        continue;
      }
      state = this.upsertLedger(state, "apply", {
        jobId,
        operation: "apply",
        status: "applying",
        fromTz: snapshot.stable.schedule.tz,
        toTz: trip.targetTz,
        updatedAt: this.nowIso(),
      });

      try {
        await this.cron.editJobTimezone(snapshot.raw, trip.targetTz);
        const after = snapshotCronJob(await this.cron.showJob(jobId));
        if (!after) {
          throw new TravelCronError(
            "post_edit_missing",
            `Cron job ${jobId} could not be refetched after edit.`,
          );
        }
        const expectedAfter = withTimezone(snapshot.stable, trip.targetTz);
        if (
          !samePersistedExceptTimezone(after.stable, expectedAfter) ||
          after.stable.schedule.tz !== trip.targetTz
        ) {
          await this.restoreAppliedBestEffort([...appliedIds, jobId], applySnapshot);
          state.phase = "recoverable_error";
          const incompatibleMessage =
            "OpenClaw cron edit changed non-schedule fields. The plugin attempted to restore already-edited jobs and marked the install incompatible.";
          state.lastError = incompatibleMessage;
          state = this.upsertLedger(state, "apply", {
            jobId,
            operation: "apply",
            status: "failed",
            message: incompatibleMessage,
            updatedAt: this.nowIso(),
          });
          return {
            ok: false,
            phase: state.phase,
            revision: state.revision,
            message: incompatibleMessage,
            upgradeInstruction:
              "Upgrade OpenClaw and retry after verifying `openclaw cron edit` preserves name, message, and session when schedule flags are supplied.",
          };
        }

        appliedIds.push(jobId);
        state = this.upsertLedger(state, "apply", {
          jobId,
          operation: "apply",
          status: "applied",
          fromTz: snapshot.stable.schedule.tz,
          toTz: trip.targetTz,
          updatedAt: this.nowIso(),
        });
      } catch (error) {
        state.phase = "apply_failed_partial";
        state.lastError = errorMessage(error);
        state = this.upsertLedger(state, "apply", {
          jobId,
          operation: "apply",
          status: "failed",
          message: state.lastError,
          updatedAt: this.nowIso(),
        });
        return {
          ok: false,
          phase: state.phase,
          revision: state.revision,
          message: `Apply failed after ${appliedIds.length} job(s): ${state.lastError}`,
          safestNextAction: "abort_or_recover_travel_cron?action=recover",
        };
      }
    }

    state.phase = "active";
    state.apply = {
      ...state.apply,
      applySnapshot,
      appliedAt: this.nowIso(),
      ledger: state.apply?.ledger ?? [],
    };
    state = this.save(state);
    return {
      ok: true,
      phase: state.phase,
      revision: state.revision,
      message: `Travel cron plan is active. Applied ${committed.moveJobIds.length} timezone change(s) by ${reason}.`,
      appliedJobIds: committed.moveJobIds,
      restoreDueAt: trip.endsAt,
    };
  }

  private async restoreLocked(
    state: TravelCronState,
    options: {
      force: boolean;
      reason: "scheduled_restore" | "manual_restore" | "abort" | "recovery";
      successPhase: TravelCronPhase;
      skippedPhase: TravelCronPhase;
    },
  ): Promise<ToolBody> {
    requirePhaseOneOf(state, [
      "active",
      "applying",
      "restoring",
      "apply_failed_partial",
      "restore_failed_partial",
      "recoverable_error",
    ]);

    const trip = requireTrip(state);
    const apply = state.apply;
    if (!apply) {
      throw new TravelCronError("missing_apply_state", "No apply ledger exists to restore.");
    }

    const appliedJobIds = new Set(
      apply.ledger
        .filter((entry) => entry.operation === "apply" && entry.status === "applied")
        .map((entry) => entry.jobId),
    );
    state.phase = "restoring";
    state.restore = {
      reason: options.reason,
      force: options.force,
      ledger: state.restore?.ledger ?? [],
    };
    state.pendingConfirmation = undefined;
    state.attentionRequired = undefined;
    state = this.save(state);

    const restored: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const jobId of appliedJobIds) {
      const original = apply.applySnapshot[jobId];
      if (!original) {
        skipped.push(jobId);
        state = this.upsertLedger(state, "restore", {
          jobId,
          operation: "restore",
          status: "skipped_missing",
          message: "Missing original apply-time snapshot.",
          updatedAt: this.nowIso(),
        });
        continue;
      }

      let currentSnapshot: SnapshotJob | null = null;
      try {
        currentSnapshot = snapshotCronJob(await this.cron.showJob(jobId));
      } catch {
        currentSnapshot = null;
      }

      if (!currentSnapshot) {
        skipped.push(jobId);
        state = this.upsertLedger(state, "restore", {
          jobId,
          operation: "restore",
          status: "skipped_missing",
          message: "Cron job no longer exists.",
          updatedAt: this.nowIso(),
        });
        continue;
      }

      const expectedTravel = withTimezone(original.stable, trip.targetTz);
      const drifted =
        stableStringify(strictPersistedFields(currentSnapshot.stable)) !==
        stableStringify(strictPersistedFields(expectedTravel));
      if (drifted && !options.force) {
        skipped.push(jobId);
        state = this.upsertLedger(state, "restore", {
          jobId,
          operation: "restore",
          status: "skipped_drift",
          message: "Current job differs from travel-mode snapshot; skipped without force.",
          updatedAt: this.nowIso(),
        });
        continue;
      }

      state = this.upsertLedger(state, "restore", {
        jobId,
        operation: "restore",
        status: "restoring",
        fromTz: currentSnapshot.stable.schedule.tz,
        toTz: original.stable.schedule.tz,
        updatedAt: this.nowIso(),
      });

      try {
        const source = options.force ? original.raw : currentSnapshot.raw;
        await this.cron.editJobTimezone(source, original.stable.schedule.tz ?? "");
        const after = snapshotCronJob(await this.cron.showJob(jobId));
        if (!after || after.stableHash !== original.stableHash) {
          throw new TravelCronError(
            "restore_verification_failed",
            `Cron job ${jobId} did not match its apply-time snapshot after restore.`,
          );
        }
        restored.push(jobId);
        state = this.upsertLedger(state, "restore", {
          jobId,
          operation: "restore",
          status: "restored",
          fromTz: trip.targetTz,
          toTz: original.stable.schedule.tz,
          updatedAt: this.nowIso(),
        });
      } catch (error) {
        failed.push(jobId);
        state = this.upsertLedger(state, "restore", {
          jobId,
          operation: "restore",
          status: "failed",
          message: errorMessage(error),
          updatedAt: this.nowIso(),
        });
      }
    }

    const hasSkips = skipped.length > 0 || failed.length > 0;
    state.phase = hasSkips ? options.skippedPhase : options.successPhase;
    state.restore = {
      ...(state.restore ?? { reason: options.reason, force: options.force, ledger: [] }),
      reason: options.reason,
      force: options.force,
      restoredAt: this.nowIso(),
      ledger: state.restore?.ledger ?? [],
    };
    state.attentionRequired = hasSkips
      ? "Some moved cron jobs were skipped or failed during restore. Use status for drift details and recover with force only after review."
      : undefined;
    state = this.save(state);

    return {
      ok: !hasSkips,
      phase: state.phase,
      revision: state.revision,
      message: hasSkips
        ? `Restore completed with ${skipped.length} skipped and ${failed.length} failed job(s).`
        : `Restore completed for ${restored.length} moved job(s).`,
      restoredJobIds: restored,
      skippedJobIds: skipped,
      failedJobIds: failed,
    };
  }

  private async restoreAppliedBestEffort(
    appliedIds: string[],
    applySnapshot: Record<string, SnapshotJob>,
  ): Promise<void> {
    for (const jobId of appliedIds) {
      const snapshot = applySnapshot[jobId];
      if (!snapshot?.stable.schedule.tz) {
        continue;
      }
      try {
        await this.cron.editJobTimezone(snapshot.raw, snapshot.stable.schedule.tz);
      } catch {
        // Best-effort rollback after detecting incompatible edit semantics.
      }
    }
  }

  private upsertLedger(
    state: TravelCronState,
    operation: "apply" | "restore",
    entry: OperationLedgerEntry,
  ): TravelCronState {
    if (operation === "apply") {
      const apply = state.apply ?? { applySnapshot: {}, ledger: [] };
      apply.ledger = upsertEntry(apply.ledger, entry);
      state.apply = apply;
    } else {
      const restore = state.restore ?? { reason: "manual_restore", force: false, ledger: [] };
      restore.ledger = upsertEntry(restore.ledger, entry);
      state.restore = restore;
    }
    return this.save(state);
  }

  private async refetchSnapshotMap(): Promise<Record<string, SnapshotJob>> {
    const jobs = await this.cron.listJobs();
    return buildSnapshotMap(
      jobs
        .map((job) => snapshotCronJob(job))
        .filter((snapshot): snapshot is SnapshotJob => snapshot !== null),
    );
  }

  private async checkCronInventory(): Promise<
    { ok: true; jobs: unknown[] } | { ok: false; message: string }
  > {
    try {
      return { ok: true, jobs: await this.cron.listJobs() };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  }

  private lateActivationConfirmationIfNeeded(state: TravelCronState): {
    state: TravelCronState;
    body(state: TravelCronState): ToolBody;
  } | null {
    const trip = requireTrip(state);
    const lateAt = Date.parse(trip.startsAt) + trip.activationGraceMinutes * 60 * 1000;
    if (this.nowMs() <= lateAt) {
      return null;
    }
    const next = this.createConfirmation(
      state,
      "late_activation",
      "Travel cron activation is late but the trip is still active. Confirm within 15 minutes before changing cron timezones.",
    );
    return { state: next, body: confirmationBody };
  }

  private lateRestoreConfirmationIfNeeded(state: TravelCronState): {
    state: TravelCronState;
    body(state: TravelCronState): ToolBody;
  } | null {
    const trip = requireTrip(state);
    const lateAt = Date.parse(trip.endsAt) + trip.lateRestoreThresholdHours * 60 * 60 * 1000;
    if (this.nowMs() <= lateAt) {
      return null;
    }
    const next = this.createConfirmation(
      state,
      "late_restore",
      "Travel cron restore is overdue beyond the configured threshold. Confirm within 15 minutes before restoring home timezones.",
    );
    return { state: next, body: confirmationBody };
  }

  private createConfirmation(
    state: TravelCronState,
    kind: ConfirmationKind,
    message: string,
  ): TravelCronState {
    const nowMs = this.nowMs();
    const existing = state.pendingConfirmation;
    if (existing?.kind === kind && Date.parse(existing.expiresAt) > nowMs) {
      return state;
    }
    state.pendingConfirmation = {
      operationId: randomUUID(),
      kind,
      message,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 15 * 60 * 1000).toISOString(),
      baseRevision: state.revision + 1,
    };
    state.attentionRequired = message;
    return state;
  }

  private consumeConfirmation(
    state: TravelCronState,
    kind: ConfirmationKind,
    operationId: string,
  ): void {
    const confirmation = state.pendingConfirmation;
    if (!confirmation || confirmation.operationId !== operationId) {
      throw new TravelCronError(
        "confirmation_not_found",
        "Confirmation operation id was not found. Refresh status and request the action again.",
      );
    }
    if (confirmation.kind !== kind) {
      throw new TravelCronError(
        "confirmation_kind_mismatch",
        `Confirmation ${operationId} is for ${confirmation.kind}, not ${kind}.`,
      );
    }
    if (Date.parse(confirmation.expiresAt) <= this.nowMs()) {
      state.pendingConfirmation = undefined;
      throw new TravelCronError(
        "confirmation_expired",
        "Confirmation expired. Request a fresh operation id and try again.",
      );
    }
    if (confirmation.baseRevision !== state.revision) {
      throw new TravelCronError(
        "confirmation_stale",
        "Confirmation no longer matches the current state revision. Refresh status and request the action again.",
        { confirmationRevision: confirmation.baseRevision, stateRevision: state.revision },
      );
    }
    state.pendingConfirmation = undefined;
    state.attentionRequired = undefined;
  }

  private async computeDrift(state: TravelCronState): Promise<unknown> {
    if (!state.apply || !state.trip) {
      return { checked: false, reason: "No applied jobs." };
    }

    const applied = state.apply.ledger.filter(
      (entry) => entry.operation === "apply" && entry.status === "applied",
    );
    if (applied.length === 0) {
      return { checked: false, reason: "No applied jobs." };
    }

    const drifted: string[] = [];
    const missing: string[] = [];
    for (const entry of applied) {
      const original = state.apply.applySnapshot[entry.jobId];
      if (!original) {
        missing.push(entry.jobId);
        continue;
      }
      let current: SnapshotJob | null = null;
      try {
        current = snapshotCronJob(await this.cron.showJob(entry.jobId));
      } catch {
        current = null;
      }
      if (!current) {
        missing.push(entry.jobId);
        continue;
      }
      const expected = withTimezone(original.stable, state.trip.targetTz);
      if (
        stableStringify(strictPersistedFields(current.stable)) !==
        stableStringify(strictPersistedFields(expected))
      ) {
        drifted.push(entry.jobId);
      }
    }

    return {
      checked: true,
      appliedJobs: applied.length,
      drifted,
      missing,
    };
  }

  private async mutate<T extends ToolBody>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withStateLock(this.paths, operation, this.config.lockTtlMs, fn);
    } catch (error) {
      if (error instanceof TravelCronError) {
        return {
          ok: false,
          message: error.message,
          code: error.code,
          details: error.details,
        } as unknown as T;
      }
      return {
        ok: false,
        message: errorMessage(error),
      } as T;
    }
  }

  private save(state: TravelCronState): TravelCronState {
    return writeState(this.paths, state, this.nowIso());
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }
}

function buildTripWindow(
  params: GenerateDraftParams,
  config: TravelCronConfig,
): TripWindow {
  return {
    startsAt: params.startsAt,
    endsAt: params.endsAt,
    targetTz: params.targetTz,
    lateRestoreThresholdHours:
      params.lateRestoreThresholdHours ?? config.defaultLateRestoreThresholdHours,
    activationGraceMinutes: params.activationGraceMinutes ?? config.activationGraceMinutes,
  };
}

function validateTripWindow(trip: TripWindow): void {
  const startsAt = Date.parse(trip.startsAt);
  const endsAt = Date.parse(trip.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    throw new TravelCronError(
      "invalid_trip_time",
      "startsAt and endsAt must be absolute ISO 8601 instants.",
    );
  }
  if (startsAt >= endsAt) {
    throw new TravelCronError("invalid_trip_window", "startsAt must be before endsAt.");
  }
  validateIanaTimezone(trip.targetTz, "targetTz");
}

function validateIanaTimezone(timezone: string, label: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new TravelCronError(
      "invalid_timezone",
      `${label} must be a valid IANA timezone, got ${timezone}.`,
    );
  }
}

function normalizeAdoptedJobs(movedJobs: AdoptedJobInput[]): AdoptedJobInput[] {
  if (!Array.isArray(movedJobs) || movedJobs.length === 0) {
    throw new TravelCronError(
      "adopt_jobs_required",
      "Adoption requires at least one moved job with id and originalTz.",
    );
  }

  const seen = new Set<string>();
  return movedJobs.map((job) => {
    if (!job.id || !job.originalTz) {
      throw new TravelCronError(
        "adopt_job_invalid",
        "Each adopted moved job requires id and originalTz.",
        job,
      );
    }
    if (seen.has(job.id)) {
      throw new TravelCronError(
        "duplicate_adopted_job",
        `Adopted job ${job.id} was provided more than once.`,
      );
    }
    seen.add(job.id);
    return { ...job };
  });
}

function normalizeDecisions(
  decisions: DecisionInput[],
  summaries: DraftJobSummary[],
): Map<string, DecisionInput> {
  const allowed = new Set(summaries.map((summary) => summary.id));
  const result = new Map<string, DecisionInput>();
  for (const decision of decisions) {
    if (!allowed.has(decision.id)) {
      throw new TravelCronError(
        "unknown_decision_job",
        `Decision references unknown draft job ${decision.id}.`,
      );
    }
    if (result.has(decision.id)) {
      throw new TravelCronError(
        "duplicate_decision",
        `Decision for cron job ${decision.id} was provided more than once.`,
      );
    }
    result.set(decision.id, { ...decision });
  }
  return result;
}

function requireExistingState(state: TravelCronState | null): asserts state is TravelCronState {
  if (!state) {
    throw new TravelCronError("no_plan", "No travel cron plan exists.");
  }
}

function requireExpectedRevisionUnlessConfirmed(
  expectedRevision: number | undefined,
  confirmOperationId: string | undefined,
): void {
  if (confirmOperationId || expectedRevision !== undefined) {
    return;
  }
  throw new TravelCronError(
    "expected_revision_required",
    "This mutating operation requires expectedRevision from the latest status/tool response, unless it is confirming an operationId.",
  );
}

function requirePhase(
  state: TravelCronState | null,
  phase: TravelCronPhase,
): asserts state is TravelCronState {
  requireExistingState(state);
  if (state.phase !== phase) {
    throw new TravelCronError(
      "wrong_phase",
      `Expected plan phase ${phase}, but current phase is ${state.phase}.`,
      { phase: state.phase },
    );
  }
}

function requirePhaseOneOf(
  state: TravelCronState,
  phases: TravelCronPhase[],
): void {
  if (!phases.includes(state.phase)) {
    throw new TravelCronError(
      "wrong_phase",
      `Expected one of ${phases.join(", ")}, but current phase is ${state.phase}.`,
      { phase: state.phase },
    );
  }
}

function requireTrip(state: TravelCronState): TripWindow {
  if (!state.trip) {
    throw new TravelCronError("missing_trip", "Travel window is missing from state.");
  }
  return state.trip;
}

function requireCommitted(state: TravelCronState) {
  if (!state.committed) {
    throw new TravelCronError("missing_commit", "Committed plan details are missing.");
  }
  return state.committed;
}

function upsertEntry(
  entries: OperationLedgerEntry[],
  entry: OperationLedgerEntry,
): OperationLedgerEntry[] {
  const index = entries.findIndex(
    (existing) => existing.operation === entry.operation && existing.jobId === entry.jobId,
  );
  if (index === -1) {
    return [...entries, entry];
  }
  const next = [...entries];
  next[index] = entry;
  return next;
}

function confirmationBody(state: TravelCronState): ToolBody {
  const confirmation = state.pendingConfirmation;
  if (!confirmation) {
    throw new TravelCronError(
      "missing_confirmation",
      "Expected a pending confirmation but none exists.",
    );
  }
  return {
    ok: false,
    phase: state.phase,
    revision: state.revision,
    message: confirmation.message,
    confirmationRequired: true,
    operationId: confirmation.operationId,
    expiresAt: confirmation.expiresAt,
  };
}

function findLegacyHelperJobs(rawJobs: unknown[]): Array<{
  id?: string;
  name?: string;
  marker: string;
}> {
  const markers = ["cron_travel_mode", "openclaw:travel-mode", "Travel mode restore"];
  const matches: Array<{ id?: string; name?: string; marker: string }> = [];
  for (const rawJob of rawJobs) {
    const text = JSON.stringify(rawJob);
    const marker = markers.find((candidate) => text.includes(candidate));
    if (!marker) {
      continue;
    }
    const object = rawJob && typeof rawJob === "object" ? (rawJob as Record<string, unknown>) : {};
    matches.push({
      id: readOptionalString(object.id) ?? readOptionalString(object.jobId),
      name: readOptionalString(object.name),
      marker,
    });
  }
  return matches;
}

function summarizePluginOwnedMovedJobs(state: TravelCronState | null): Array<{
  id: string;
  fromTz?: string;
  toTz?: string;
  snapshotPresent: boolean;
  adopted: boolean;
}> {
  const applied = state?.apply?.ledger.filter(
    (entry) => entry.operation === "apply" && entry.status === "applied",
  );
  if (!applied) {
    return [];
  }
  const adoptedIds = new Set(state?.adoption?.jobIds ?? []);
  return applied.map((entry) => ({
    id: entry.jobId,
    fromTz: entry.fromTz,
    toTz: entry.toTz,
    snapshotPresent: Boolean(state?.apply?.applySnapshot[entry.jobId]),
    adopted: adoptedIds.has(entry.jobId),
  }));
}

function isDriftResult(value: unknown): value is { drifted: string[]; missing: string[] } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { drifted?: unknown }).drifted) &&
    Array.isArray((value as { missing?: unknown }).missing)
  );
}

function statusMessage(state: TravelCronState): string {
  switch (state.phase) {
    case "draft":
      return "A draft exists. The safest next action is to commit explicit move, stay, and needs_review decisions.";
    case "committed":
      return "A plan is committed but not applied. The safest next action is apply now or schedule passive activation.";
    case "scheduled":
      return "A plan is scheduled. Passive reconciliation will apply it on a future tool call during the trip window.";
    case "active":
      return "Travel cron mode is active. The safest next action is to wait for restore or request restore/abort explicitly.";
    case "apply_failed_partial":
      return "Apply failed after partially changing jobs. The safest next action is abort_or_recover_travel_cron?action=recover.";
    case "restore_failed_partial":
    case "recoverable_error":
      return "Recovery is required before planning another trip.";
    case "missed_activation_noop":
      return "Activation was missed after the trip ended, so no timezone changes were applied.";
    default:
      return `Plan phase is ${state.phase}.`;
  }
}

function safestNextAction(state: TravelCronState): string {
  if (state.pendingConfirmation) {
    return `Repeat the requested tool call with confirmOperationId=${state.pendingConfirmation.operationId} before ${state.pendingConfirmation.expiresAt}.`;
  }
  switch (state.phase) {
    case "draft":
      return "generate_travel_cron_plan?action=commit";
    case "committed":
      return "apply_travel_cron_plan";
    case "scheduled":
      return "travel_cron_status after startsAt, or abort_or_recover_travel_cron?action=cancel";
    case "active":
      return "restore_travel_cron_plan at trip end, or abort_or_recover_travel_cron?action=abort for early cancellation";
    case "apply_failed_partial":
    case "restore_failed_partial":
    case "recoverable_error":
      return "abort_or_recover_travel_cron?action=recover";
    default:
      return "generate_travel_cron_plan?action=draft";
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function suggestFilters(summaries: DraftJobSummary[]): Record<string, string[]> {
  const agents = new Set<string>();
  const sessions = new Set<string>();
  for (const summary of summaries) {
    if (summary.agent) {
      agents.add(summary.agent);
    }
    if (summary.session) {
      sessions.add(summary.session);
    }
  }
  return {
    agents: [...agents].slice(0, 20),
    sessions: [...sessions].slice(0, 20),
  };
}

function stateFromBodyFallback(state: TravelCronState, body: ToolBody): TravelCronState {
  return {
    ...state,
    phase: body.phase ?? state.phase,
    revision: body.revision ?? state.revision,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
