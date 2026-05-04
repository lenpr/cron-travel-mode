# Prompt Request: Cron Travel Mode Plugin

Build an OpenClaw plugin that helps a user temporarily move selected recurring cron jobs to a travel-local timezone and later restore them safely.

The plugin is for people who already use OpenClaw cron jobs as reminders, automations, ingest jobs, social posting tasks, backups, and similar scheduled workflows. When they travel, some jobs should keep firing at the same local wall-clock time in the destination timezone, while other jobs should stay pinned to the home timezone. The plugin should make that decision reviewable, apply only the approved timezone changes, and make restoration safe and predictable.

## Intended Outcome

The user should be able to:

- review a compact inventory of existing cron jobs
- decide which jobs should follow travel-local time
- explicitly leave other jobs unchanged
- mark ambiguous jobs for review rather than editing them
- apply the approved timezone changes immediately or schedule them for passive activation
- adopt already-shifted cron jobs after migrating from a legacy or manual travel-mode setup
- restore moved jobs to their original timezone after the trip
- recover deterministically from partial apply, partial restore, cancellation, overdue restore, or manual drift

The plugin should not try to decide which jobs are personal, business-critical, timezone-sensitive, or safe to move. That discussion belongs to the human user and the agent. The plugin owns the deterministic mechanics.

## Core Product Principles

Safety is more important than convenience. A cron schedule can trigger messages, writes, backups, or external actions, so every destructive or surprising transition should be explicit, recoverable, and easy to explain.

The plugin should be conservative by default. It should refuse ambiguous cron jobs, reject stale approvals, and preserve user edits made outside the plugin.

The user should never need to inspect hidden state files to understand what happened. Status and recovery tools should report the current phase, the safest next action, skipped jobs, drift, overdue actions, and any confirmation that is required.

## Division Of Responsibility

The agent or LLM handles:

- interpreting the user's trip in natural language
- converting travel times into absolute ISO 8601 instants
- discussing which jobs should move, stay, or need review
- explaining tradeoffs and asking for confirmation

The plugin handles:

- listing cron jobs
- compacting inventory for review
- storing local state
- enforcing single-plan semantics
- validating freshness before commit/apply/restore
- editing cron job timezones
- recording what was changed
- detecting drift
- restoring only jobs that the plugin moved
- deterministic recovery from interrupted operations

This split is intentional. Timezone math, user preference, and classification are conversational tasks. State transitions and cron mutation are deterministic tasks.

## Planning Model

V1 should support exactly one travel plan at a time. If a plan is scheduled, active, or partially failed, a new draft should be rejected until the existing plan is restored, cancelled, or recovered. Avoid overlapping-trip complexity.

Tools should accept strictly absolute `startsAt` and `endsAt` instants plus an IANA `targetTz`. Do not accept fuzzy trip descriptions inside the plugin. The agent should convert "next Monday morning in Berlin" into exact instants before calling the tool.

The draft phase should fetch the current cron inventory and store the raw snapshot locally, but only return compact summaries to the agent. The LLM should not receive raw cron JSON.

The commit phase should persist explicit decisions: `move`, `stay`, or `needs_review`.

The adoption path should exist for migration only. If a host already has travel-mode timezone changes applied before installing the plugin, the plugin should be able to adopt those live moved jobs from an explicit manifest. That manifest must include each job id and its original timezone because the plugin cannot infer the home timezone from the current shifted schedule. Adoption should not edit cron; it should only verify the current travel timezone and create restore ownership state.

## Cron Jobs That May Be Edited

Only recurring cron jobs with explicit IANA timezones should be editable.

Jobs without an explicit timezone should be forced to `needs_review` and never edited automatically. The plugin should not infer what timezone OpenClaw would use implicitly.

A move should preserve the cron expression and change only the timezone. For example:

```text
0 9 * * * in America/Los_Angeles -> 0 9 * * * in Europe/Berlin
```

DST behavior should be delegated to OpenClaw's IANA timezone scheduler.

## Mutation And Restore Semantics

Apply should:

- refetch cron before editing
- validate approved move jobs against the committed snapshot
- capture an apply-time snapshot
- edit move jobs one at a time
- record a per-job operation ledger
- verify that non-timezone fields were preserved

Restore should:

- touch only jobs that were moved by this plan
- never touch `stay` or `needs_review` jobs
- restore safe moved jobs even if another moved job has drifted
- skip drifted jobs unless the user gives a fresh force confirmation
- preserve the user's external edits wherever possible

Abort during an active trip should use the same safe restore path. Because restoring early can change when jobs next fire, it should require explicit confirmation before reverting active travel schedules.

Adoption should synthesize apply-time restore snapshots from the current persisted cron fields plus the supplied original timezone. This keeps restore deterministic after migration while avoiding any attempt to discover or guess historical state.

## Confirmation Model

Any action that could surprise the user should use a deterministic two-step confirmation.

The first tool call should return `confirmationRequired: true` and an expiring operation id. The follow-up call must include that operation id. Old operation ids should expire quickly, such as after 15 minutes, so stale approvals cannot execute days later.

Use confirmations for:

- late activation during an already-started trip
- overdue restore beyond a threshold
- early active abort restore
- force restore of drifted jobs

## Time And Reconciliation Model

Do not rely on long-lived plugin timers. OpenClaw may suspend or terminate idle plugins.

Instead, reconcile passively whenever any plugin tool is invoked. If the trip should have activated or restored while the host was asleep, offline, or idle, the next tool call should move the state forward safely.

Expected reconciliation behavior:

- if activation was missed and the trip has already ended, mark `missed_activation_noop`
- if activation is late but the trip is still active, require confirmation before applying
- if restore is overdue beyond the configured threshold, require confirmation before restoring

## State And Concurrency

Use small local JSON state. SQLite or external services are unnecessary for V1 and add install fragility.

State writes should be atomic. Use a temp file in the same directory and replace the canonical state file with a rename.

Use a small advisory lock file for cross-process safety. Do not rely on in-memory mutexes, PID files, process listing, or platform-specific process detection. The lock and revision protocol should be the concurrency boundary.

Every mutating operation should compare the expected revision before proceeding. If the state changed, reject and ask the agent to refresh status.

Stale locks should be cleared automatically by status or any mutating tool after expiry. The user should never have to inspect hidden folders.

## Inventory Review

The plugin should return a compact filtered inventory, not raw cron JSON. Include only the information needed for classification:

- id
- name
- enabled state
- cron expression
- explicit timezone
- delivery/session
- agent or session metadata where available
- truncated message or description
- whether the job is editable

Exclude volatile fields from stable hashes, such as next run, last run, run count, diagnostics, previews, history, and error history. Hash only persisted fields that matter for safe mutation.

If inventory is too large, ask the user to filter by name, agent, channel, or session. V1 should prefer rigorous filtering over pagination.

## Recovery Tooling

Expose one deterministic escape hatch for recovery. It should handle:

- cancelling a draft or committed plan
- aborting an active trip
- partial apply
- partial restore
- overdue restore
- drifted jobs
- stale locks

The recovery result should be human-readable and should recommend the safest next action. It should not dump raw internal JSON at the user.

Expose a doctor or self-check surface for operators. It should report the plugin path, state path, legacy helper cron matches, whether moved jobs are plugin-owned, drift, and the limits of any allow-list visibility. The user should have a safe smoke-test tool before asking the agent to mutate cron.

## Non-Goals For V1

Do not implement overlapping trips.

Do not create helper cron jobs that depend on an LLM following a prompt correctly.

Do not require long-lived in-process timers.

Do not edit implicit-timezone jobs.

Do not silently force restore drifted jobs.

Do not mutate cron through undocumented APIs or hidden state files.

Do not send raw cron inventory to the LLM.

Do not pretend the plugin can infer historical restore state. Migration/adoption requires explicit original-timezone input.

## Testing Expectations

A reimplementation should test both deterministic state mechanics and real cron behavior.

Unit tests should cover:

- atomic JSON writes
- stale lock cleanup
- revision conflicts
- inventory filtering and stable hashing
- implicit-timezone refusal
- move/stay/needs_review commit behavior
- passive reconciliation
- missed activation
- late restore confirmation
- early abort confirmation
- partial apply and partial restore recovery
- drift detection and force restore
- adoption from already shifted jobs
- doctor/self-check reporting

End-to-end tests against a real OpenClaw host should use disposable cron jobs only. They should verify:

- explicit-timezone jobs move and restore correctly
- enabled and disabled states are preserved
- delivery/session/message fields are preserved
- implicit-timezone jobs are not edited
- stay jobs are untouched
- scheduled activation reconciles passively
- missed activation does not edit cron
- overdue restore requires confirmation
- early abort requires confirmation
- drifted jobs are skipped until force confirmation
- already shifted jobs can be adopted and restored
- the doctor surface reports plugin-owned moved jobs
- all disposable jobs are cleaned up

## Success Criteria

The plugin is successful if a user can confidently travel with selected cron jobs following destination-local wall-clock time, while unrelated or ambiguous cron jobs remain untouched, and the user has a clear, deterministic path to restore or recover at any point.
