# Agent Guide

This repository contains a native TypeScript OpenClaw plugin. Treat it as cron-mutating infrastructure: preserve safety invariants first, then improve ergonomics.

## Start Here

- Product intent: `PROMPT_REQUEST.md`
- Operator README: `README.md`
- Architecture map: `docs/architecture.md`
- Real-host e2e procedure: `docs/remote-openclaw-test.md`
- ClawHub release procedure: `docs/clawhub-publishing.md`

## Core Invariants

- V1 is strictly single-plan. Do not add overlapping trip behavior casually.
- The plugin accepts absolute ISO 8601 `startsAt` and `endsAt`; the agent converts human dates.
- Only explicit-timezone recurring cron jobs are editable.
- `stay` and `needs_review` jobs are never restored or mutated.
- Restore touches only jobs moved by the current plan.
- Drifted moved jobs are skipped unless force restore is freshly confirmed.
- Surprising actions use expiring operation ids: late activation, late restore, early abort, force restore.
- Passive reconciliation happens on tool calls. Do not introduce long-lived timers for v1.
- Cron mutation must go through documented `openclaw cron` CLI behavior.

## Code Map

- `src/index.ts`: OpenClaw plugin entrypoint and tool schemas.
- `src/service.ts`: travel-plan state machine and tool behavior.
- `src/cron-client.ts`: OpenClaw cron CLI adapter.
- `src/hash.ts`: cron normalization, stable hashing, compact inventory summaries.
- `src/state.ts`: atomic JSON state writes, lock file, stale lock cleanup.
- `src/types.ts`: shared state and tool-result types.

## Testing

Run local deterministic tests:

```bash
npm run check
```

Run guarded real OpenClaw e2e only against a host where disposable cron jobs are acceptable:

```bash
OPENCLAW_BIN=/path/to/openclaw npm run test:e2e:openclaw
```

The e2e creates jobs prefixed with `ctm-e2e-*`, including one enabled `--no-deliver` job. It must clean up every disposable job.

## Release Checks

Before publishing:

```bash
npm run check
npm run pack:dry-run
npm run clawhub:dry-run
```

`dist/` is intentionally ignored. Build before linked installs and before ClawHub folder dry-runs.

## Editing Guidance

- Keep behavior changes covered by unit tests first; add real e2e only for actual OpenClaw CLI integration risk.
- Do not weaken revision, lock, confirmation, or drift checks to simplify a flow.
- Prefer small focused helpers over broad refactors of `src/service.ts`; it is large because it centralizes state-machine behavior.
- Keep docs in sync with test coverage and release scripts.
