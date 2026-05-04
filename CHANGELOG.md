# Changelog

## 0.1.0 - 2026-05-04

- Initial Cron Travel Mode plugin release.
- Adds draft, commit, apply, restore, recover, and status tools for single-trip cron timezone travel mode.
- Uses JSON state, advisory lock files, revision checks, passive reconciliation, and OpenClaw cron CLI mutations only.
- Includes unit tests plus guarded real OpenClaw e2e coverage for disposable disabled cron jobs.
