# Cron Travel Mode

Native TypeScript OpenClaw plugin for temporarily moving approved explicit-timezone cron jobs to travel-local time and restoring them safely.

## Documentation Map

- [PROMPT_REQUEST.md](PROMPT_REQUEST.md): intent and design choices for reimplementation.
- [AGENTS.md](AGENTS.md): coding-agent guide for maintaining this repository.
- [docs/architecture.md](docs/architecture.md): state machine, tool flow, and safety boundaries.
- [docs/remote-openclaw-test.md](docs/remote-openclaw-test.md): guarded real-host e2e procedure.
- [docs/clawhub-publishing.md](docs/clawhub-publishing.md): ClawHub release checklist.

## What it does

The plugin owns deterministic mechanics only:

- inventory compaction and stable hashing, including disabled jobs via `cron list --all --json`
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
  - `action: "draft"` fetches cron inventory, including disabled jobs, and returns compact job summaries.
  - `action: "commit"` persists move, stay, and needs_review decisions.
- `adopt_active_travel_cron_plan`
  - imports already travel-shifted cron jobs from an explicit original-timezone manifest so the plugin can own restore state after migration.
- `apply_travel_cron_plan`
  - applies immediately or marks a committed plan for passive activation.
- `restore_travel_cron_plan`
  - restores moved jobs from the apply-time snapshot.
- `abort_or_recover_travel_cron`
  - deterministic cancel, abort, partial-apply, partial-restore, and recovery entrypoint.
- `travel_cron_status`
  - returns plain-language state, drift, pending confirmations, and safest next action.
- `travel_cron_doctor`
  - reports install health, state paths, legacy helper cron matches, plugin-owned moved jobs, drift, and allow-list verification guidance.

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
- OpenClaw `2026.5.2` or newer

Install dependencies:

```bash
npm install
```

Run type checks and tests:

```bash
npm run check
```

Build the publishable runtime:

```bash
npm run build
```

The package ships built JavaScript from `dist/` for managed OpenClaw installs while keeping TypeScript source in the repository for review and linked development.

## Install From ClawHub

After publication, install the managed package with:

```bash
openclaw plugins install clawhub:@lenpr/cron-travel-mode
openclaw plugins enable cron-travel-mode
openclaw gateway restart
openclaw plugins doctor
```

OpenClaw validates the package's advertised plugin API and Gateway compatibility before installing it.

## Install From GitHub

Install the plugin on an OpenClaw host from a local checkout:

```bash
git clone https://github.com/lenpr/cron-travel-mode.git
cd cron-travel-mode
npm ci
npm run build
openclaw plugins install --link "$PWD"
openclaw plugins enable cron-travel-mode
openclaw gateway restart
openclaw plugins doctor
```

If `openclaw` is not on `PATH` in non-interactive SSH shells, use the absolute binary path. On some hosts this is:

```bash
/home/openclaw/.npm-global/bin/openclaw
```

The tools are registered as optional because they can mutate cron jobs. Make sure the plugin or individual tools are allowed in your OpenClaw tool configuration before asking an agent to use them.

## Tool Allow-List

On hosts that enforce `tools.allow`, add the plugin id or the individual tool names before asking an agent to plan or mutate cron:

```bash
openclaw config get tools.allow
```

If the plugin is not allowed, patch the host configuration using your normal OpenClaw config workflow, then validate and restart:

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins doctor
```

After restart, run the plugin self-check through an agent session:

```bash
openclaw agent --local --json --message "Call the cron-travel-mode tool travel_cron_doctor now and return its result."
```

The doctor tool can confirm that it is callable, list the registered tool names, and report the plugin state path. The OpenClaw plugin SDK does not expose the full host `tools.allow` list to plugin code, so use `openclaw config get tools.allow` as the source of truth for allow-list setup.

## Migration And Adoption

If you install the plugin on a host that already has travel-mode cron timezone changes applied, do not draft a new trip first. The plugin cannot infer the original timezone from a live shifted cron job.

Use `adopt_active_travel_cron_plan` with:

- absolute `startsAt` and `endsAt` instants for the current trip
- the live travel `targetTz`
- `movedJobs` entries containing each shifted cron job id and its `originalTz`

Adoption does not edit cron. It verifies each listed job currently has an explicit timezone equal to `targetTz`, synthesizes restore snapshots from current persisted fields plus `originalTz`, records the jobs as already applied, and moves the plugin state to `active`.

After adoption, run:

```bash
openclaw agent --local --json --message "Call travel_cron_status for cron-travel-mode and report the safest next action."
```

If `travel_cron_doctor` reports no plugin-owned moved jobs but you know jobs are already travel-shifted, use adoption before restore.

## Non-Interactive Smoke Tests

Some OpenClaw installations do not expose a direct `openclaw invoke` command, or may exclude invoke-style helpers from `plugins.allow`. The portable smoke path is an explicit local agent turn:

```bash
openclaw agent --local --json --message "Call the cron-travel-mode tool travel_cron_doctor now. Do not change cron."
openclaw agent --local --json --message "Call the cron-travel-mode tool travel_cron_status now. Do not change cron unless passive reconciliation is due."
```

`travel_cron_status` participates in passive reconciliation, so it can apply or restore when the stored trip window says that action is due. Use `travel_cron_doctor` when you only need installation and ownership health.

## End-To-End Test Against OpenClaw

The normal test suite uses a fake cron client and never touches a real OpenClaw scheduler:

```bash
npm run check
```

To run the guarded e2e test against a real OpenClaw host, opt in explicitly:

```bash
OPENCLAW_BIN=/home/openclaw/.npm-global/bin/openclaw npm run test:e2e:openclaw
```

The e2e test creates disposable cron jobs with names prefixed by `ctm-e2e-*`, including one enabled `--no-deliver` job. It verifies move, stay, implicit-timezone refusal, enabled/disabled preservation, passive activation, missed activation, late restore confirmation, early abort confirmation, drift skip, force restore, and cleanup.

See [docs/remote-openclaw-test.md](docs/remote-openclaw-test.md) for the remote-host test procedure.

## ClawHub Publishing

ClawHub is the canonical discovery surface for community plugins. This repository includes OpenClaw package metadata, a built runtime entrypoint, a GitHub Actions CI workflow, and dry-run scripts for package validation:

```bash
npm run pack:dry-run
npm run clawhub:dry-run
```

See [docs/clawhub-publishing.md](docs/clawhub-publishing.md) for the full release checklist and publish commands.

## License

MIT License. See [LICENSE](LICENSE).
