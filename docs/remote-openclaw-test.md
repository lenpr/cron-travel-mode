# Remote OpenClaw Test Procedure

This document describes the manual procedure used to validate Cron Travel Mode against a real OpenClaw scheduler without touching existing user cron jobs.

## Safety Rules

- Use disabled disposable cron jobs only.
- Prefix disposable job names with `ctm-e2e-`.
- Use `--no-deliver` so runner fallback delivery stays disabled.
- Filter drafts by the disposable prefix.
- Remove disposable jobs after the test.
- Do not approve existing user cron jobs during e2e validation.

## Remote Setup

When SSH non-interactive shells do not load the OpenClaw CLI path, use the absolute binary:

```bash
OPENCLAW=/home/openclaw/.npm-global/bin/openclaw
```

Check the host:

```bash
ssh horst-tailscale-openclaw "$OPENCLAW --version"
ssh horst-tailscale-openclaw "$OPENCLAW plugins doctor"
ssh horst-tailscale-openclaw "$OPENCLAW cron list --json"
```

## Install Or Update The Plugin

```bash
ssh horst-tailscale-openclaw '
  set -euo pipefail
  OPENCLAW=/home/openclaw/.npm-global/bin/openclaw
  mkdir -p ~/Coding
  if [ -d ~/Coding/cron-travel-mode/.git ]; then
    git -C ~/Coding/cron-travel-mode pull --ff-only
  else
    git clone https://github.com/lenpr/cron-travel-mode.git ~/Coding/cron-travel-mode
  fi
  cd ~/Coding/cron-travel-mode
  npm ci
  "$OPENCLAW" plugins install --link --force "$PWD"
  "$OPENCLAW" plugins enable cron-travel-mode
  "$OPENCLAW" plugins doctor
'
```

## Run The E2E Test

```bash
ssh horst-tailscale-openclaw '
  set -euo pipefail
  cd ~/Coding/cron-travel-mode
  OPENCLAW_BIN=/home/openclaw/.npm-global/bin/openclaw npm run test:e2e:openclaw
'
```

Expected result:

- the test creates three disabled disposable cron jobs
- only the explicit-timezone `move` job changes timezone
- the `stay` job remains unchanged
- the implicit-timezone job is refused for editing
- restore returns the moved job to its original timezone
- all disposable jobs are removed

## Cleanup Check

```bash
ssh horst-tailscale-openclaw '
  /home/openclaw/.npm-global/bin/openclaw cron list --json |
    node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const j=JSON.parse(s);const jobs=Array.isArray(j)?j:(j.jobs||j.items||[]);console.log(jobs.filter(job=>JSON.stringify(job).includes(\"ctm-e2e-\")).length)})"
'
```

The cleanup count should be `0`.
