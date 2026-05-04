import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { OpenClawCliCronClient } from "./cron-client.js";
import { createStatePaths } from "./state.js";
import { DEFAULT_CONFIG, TravelCronService } from "./service.js";
import { PLUGIN_ID, TOOL_NAMES, type TravelCronConfig } from "./types.js";

const InventoryFilterSchema = Type.Optional(
  Type.Object(
    {
      nameIncludes: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      session: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
);

const ExpectedRevisionSchema = Type.Optional(
  Type.Number({
    description:
      "Revision returned by the previous tool/status call. Mutations reject if state changed.",
  }),
);

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Cron Travel Mode",
  description:
    "Review OpenClaw cron jobs, move approved explicit-timezone schedules to travel-local time, and safely restore them.",
  register(api) {
    const statePaths = createStatePaths(api.runtime.state.resolveStateDir());
    const config = readConfig(api.pluginConfig ?? {});
    const service = new TravelCronService(
      statePaths,
      new OpenClawCliCronClient("openclaw", async (command, args) => {
        const output = await api.runtime.system.runCommandWithTimeout(
          [command, ...args],
          { timeoutMs: 30_000 },
        );
        if (output.code !== 0) {
          throw new Error(output.stderr || `Command exited with code ${output.code}`);
        }
        return { stdout: output.stdout, stderr: output.stderr };
      }),
      undefined,
      config,
    );

    api.registerTool(
      {
        name: TOOL_NAMES.generate,
        label: "Generate travel cron plan",
        description:
          "Draft or commit a single travel cron plan. Draft accepts absolute ISO instants and returns compact cron summaries; commit persists move/stay/needs_review decisions.",
        parameters: Type.Object(
          {
            action: Type.Union([Type.Literal("draft"), Type.Literal("commit")]),
            startsAt: Type.Optional(Type.String()),
            endsAt: Type.Optional(Type.String()),
            targetTz: Type.Optional(Type.String()),
            expectedRevision: ExpectedRevisionSchema,
            filter: InventoryFilterSchema,
            lateRestoreThresholdHours: Type.Optional(Type.Number()),
            activationGraceMinutes: Type.Optional(Type.Number()),
            maxInventoryJobs: Type.Optional(Type.Number()),
            maxInventoryBytes: Type.Optional(Type.Number()),
            decisions: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    id: Type.String(),
                    decision: Type.Union([
                      Type.Literal("move"),
                      Type.Literal("stay"),
                      Type.Literal("needs_review"),
                    ]),
                    reason: Type.Optional(Type.String()),
                  },
                  { additionalProperties: false },
                ),
              ),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params) {
          const input = params as GenerateToolInput;
          if (input.action === "draft") {
            if (!input.startsAt || !input.endsAt || !input.targetTz) {
              return result({
                ok: false,
                message: "Draft requires startsAt, endsAt, and targetTz.",
              });
            }
            return result(
              await service.draft({
                startsAt: input.startsAt,
                endsAt: input.endsAt,
                targetTz: input.targetTz,
                expectedRevision: input.expectedRevision,
                filter: input.filter,
                lateRestoreThresholdHours: input.lateRestoreThresholdHours,
                activationGraceMinutes: input.activationGraceMinutes,
                maxInventoryJobs: input.maxInventoryJobs,
                maxInventoryBytes: input.maxInventoryBytes,
              }),
            );
          }

          if (input.expectedRevision === undefined || !input.decisions) {
            return result({
              ok: false,
              message: "Commit requires expectedRevision and decisions.",
            });
          }
          return result(
            await service.commit({
              expectedRevision: input.expectedRevision,
              decisions: input.decisions,
            }),
          );
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: TOOL_NAMES.apply,
        label: "Apply travel cron plan",
        description:
          "Apply a committed travel cron plan now, schedule it for passive activation, or confirm a late activation operation id.",
        parameters: Type.Object(
          {
            expectedRevision: ExpectedRevisionSchema,
            activationMode: Type.Optional(
              Type.Union([Type.Literal("now"), Type.Literal("scheduled")]),
            ),
            confirmOperationId: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params) {
          return result(await service.apply(params as ApplyToolInput));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: TOOL_NAMES.adopt,
        label: "Adopt active travel cron plan",
        description:
          "Import already travel-shifted cron jobs into plugin state so the plugin can safely own their restore path without editing cron during adoption.",
        parameters: Type.Object(
          {
            startsAt: Type.String(),
            endsAt: Type.String(),
            targetTz: Type.String(),
            expectedRevision: ExpectedRevisionSchema,
            source: Type.Optional(Type.String()),
            lateRestoreThresholdHours: Type.Optional(Type.Number()),
            activationGraceMinutes: Type.Optional(Type.Number()),
            movedJobs: Type.Array(
              Type.Object(
                {
                  id: Type.String(),
                  originalTz: Type.String(),
                  reason: Type.Optional(Type.String()),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params) {
          return result(await service.adoptActive(params as AdoptToolInput));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: TOOL_NAMES.restore,
        label: "Restore travel cron plan",
        description:
          "Restore moved cron jobs from the apply-time snapshot. Drifted jobs are skipped unless force is confirmed.",
        parameters: Type.Object(
          {
            expectedRevision: ExpectedRevisionSchema,
            force: Type.Optional(Type.Boolean()),
            confirmOperationId: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params) {
          return result(await service.restore(params as RestoreToolInput));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: TOOL_NAMES.recover,
        label: "Abort or recover travel cron",
        description:
          "Deterministic escape hatch for cancel, active abort, partial apply, partial restore, and recoverable states.",
        parameters: Type.Object(
          {
            expectedRevision: ExpectedRevisionSchema,
            action: Type.Optional(
              Type.Union([Type.Literal("cancel"), Type.Literal("abort"), Type.Literal("recover")]),
            ),
            force: Type.Optional(Type.Boolean()),
            confirmOperationId: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params) {
          return result(await service.recover(params as RecoverToolInput));
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: TOOL_NAMES.status,
        label: "Travel cron status",
        description:
          "Return plain-language travel cron state, drift, overdue actions, pending confirmations, and the safest next action.",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() {
          return result(await service.status());
        },
      },
      { optional: true },
    );
  },
});

function readConfig(pluginConfig: Record<string, unknown>): TravelCronConfig {
  return {
    ...DEFAULT_CONFIG,
    maxInventoryJobs: readNumber(pluginConfig.maxInventoryJobs, DEFAULT_CONFIG.maxInventoryJobs),
    maxInventoryBytes: readNumber(pluginConfig.maxInventoryBytes, DEFAULT_CONFIG.maxInventoryBytes),
    defaultLateRestoreThresholdHours: readNumber(
      pluginConfig.defaultLateRestoreThresholdHours,
      DEFAULT_CONFIG.defaultLateRestoreThresholdHours,
    ),
    activationGraceMinutes: readNumber(
      pluginConfig.activationGraceMinutes,
      DEFAULT_CONFIG.activationGraceMinutes,
    ),
  };
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface GenerateToolInput {
  action?: "draft" | "commit";
  startsAt?: string;
  endsAt?: string;
  targetTz?: string;
  expectedRevision?: number;
  filter?: {
    nameIncludes?: string;
    agent?: string;
    session?: string;
  };
  lateRestoreThresholdHours?: number;
  activationGraceMinutes?: number;
  maxInventoryJobs?: number;
  maxInventoryBytes?: number;
  decisions?: Array<{
    id: string;
    decision: "move" | "stay" | "needs_review";
    reason?: string;
  }>;
}

interface ApplyToolInput {
  expectedRevision?: number;
  activationMode?: "now" | "scheduled";
  confirmOperationId?: string;
}

interface AdoptToolInput {
  startsAt: string;
  endsAt: string;
  targetTz: string;
  expectedRevision?: number;
  source?: string;
  lateRestoreThresholdHours?: number;
  activationGraceMinutes?: number;
  movedJobs: Array<{
    id: string;
    originalTz: string;
    reason?: string;
  }>;
}

interface RestoreToolInput {
  expectedRevision?: number;
  force?: boolean;
  confirmOperationId?: string;
}

interface RecoverToolInput {
  expectedRevision?: number;
  action?: "cancel" | "abort" | "recover";
  force?: boolean;
  confirmOperationId?: string;
}

function result(body: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(body, null, 2),
      },
    ],
    details: body,
  };
}
