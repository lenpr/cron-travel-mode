# Cron Travel Mode

Native TypeScript OpenClaw plugin for temporarily moving approved explicit-timezone cron jobs to travel-local time and restoring them safely.

## What it does

The plugin owns deterministic mechanics only:

- inventory compaction and stable hashing
- single-plan JSON state
- lock-file and revision safety
- cron timezone mutation through `openclaw cron`
- passive reconciliation on every tool invocation

The agent remains responsible for converting human trip times into absolute ISO 8601 instants and discussing which jobs should move.

## Safety model

Cron Travel Mode is intentionally conservative:

- v1 supports one travel plan at a time.
- tools accept only absolute ISO 8601 `startsAt` and `endsAt` instants plus an IANA `targetTz`.
- only recurring `schedule.kind = "cron"` jobs with explicit timezones are editable.
- jobs without explicit timezones are forced to `needs_review`.
- draft hashes ignore volatile cron metadata such as next run, last run, diagnostics, and history.
- commit rejects changed or missing `move` jobs, but only warns on changed `stay` jobs.
- restore touches only jobs moved by the active plan.
- drifted moved jobs are skipped unless a fresh force confirmation is supplied.
- late activation, late restore, early active abort, and force restore use expiring operation IDs.

## Tools

- `generate_travel_cron_plan`
  - `action: "draft"` fetches cron inventory and returns compact job summaries.
  - `action: "commit"` persists move, stay, and needs_review decisions.
- `apply_travel_cron_plan`
  - applies immediately or marks a committed plan for passive activation.
- `restore_travel_cron_plan`
  - restores moved jobs from the apply-time snapshot.
- `abort_or_recover_travel_cron`
  - deterministic cancel, abort, partial-apply, partial-restore, and recovery entrypoint.
- `travel_cron_status`
  - returns plain-language state, drift, pending confirmations, and safest next action.

## State

Canonical state is stored under the OpenClaw runtime state directory:

```text
cron-travel-mode/current_travel_cron_plan.json
```

Writes use same-directory temp files plus atomic rename. Mutating operations use a tiny advisory lock file created with `fs.openSync(lockPath, "wx")`, and every mutation compares the expected state revision before proceeding.

## Cron mutation

Cron mutation goes through the documented OpenClaw CLI. Timezone updates assume `openclaw cron edit` behaves like a full PUT, so the adapter re-passes the persisted fields it must preserve:

```text
openclaw cron edit <jobId> --name <name> --message <message> --session <session> --cron <expr> --tz <targetTz>
```

After each edit, the plugin refetches the job and verifies that persisted non-timezone fields did not change.

## Development

Prerequisites:

- Node.js 22 or newer
- OpenClaw `2026.5.3-1` or newer

Install dependencies:

```bash
npm install
```

Run type checks and tests:

```bash
npm run check
```

## License

MIT License. See [LICENSE](LICENSE).
