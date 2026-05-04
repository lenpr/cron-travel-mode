# Remote OpenClaw Test Procedure

This document describes the manual procedure used to validate Cron Travel Mode against a real OpenClaw scheduler without touching existing user cron jobs.

## Safety Rules

- Use disposable cron jobs only.
- Prefix disposable job names with `ctm-e2e-`.
- Use `--no-deliver` so runner fallback delivery stays disabled.
- Enabled disposable jobs are allowed only with `--no-deliver`.
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
ssh horst-tailscale-openclaw "$OPENCLAW cron list --all --json"
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
  npm run build
  "$OPENCLAW" plugins install --link "$PWD"
  "$OPENCLAW" plugins enable cron-travel-mode
  "$OPENCLAW" gateway restart
  "$OPENCLAW" plugins doctor
'
```

## Allow Tools And Smoke Test

If the host uses a tool allow-list, confirm `cron-travel-mode` or its individual tools are allowed:

```bash
ssh horst-tailscale-openclaw '
  /home/openclaw/.npm-global/bin/openclaw config get tools.allow
'
```

After changing allow-list config through the host's normal OpenClaw configuration workflow, validate and restart:

```bash
ssh horst-tailscale-openclaw '
  set -euo pipefail
  OPENCLAW=/home/openclaw/.npm-global/bin/openclaw
  "$OPENCLAW" config validate
  "$OPENCLAW" gateway restart
  "$OPENCLAW" plugins doctor
'
```

Use the doctor tool as the first plugin smoke test:

```bash
ssh horst-tailscale-openclaw '
  /home/openclaw/.npm-global/bin/openclaw agent --local --json \
    --message "Call the cron-travel-mode tool travel_cron_doctor now and return its result."
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

- the test creates disabled disposable cron jobs plus one enabled `--no-deliver` disposable cron job
- explicit-timezone `move` jobs change timezone and preserve enabled/disabled state
- the `stay` job remains unchanged
- the implicit-timezone job is refused for editing
- passive scheduled activation applies on the next tool/service call after the trip start
- missed scheduled activation after trip end becomes `missed_activation_noop` without editing cron
- overdue restore requires confirmation before reverting timezones
- early active abort requires confirmation before reverting timezones
- manually drifted moved jobs are skipped until force restore is confirmed
- an already shifted disposable job can be adopted and restored from a supplied original timezone
- the doctor surface reports plugin-owned moved jobs
- restore returns moved jobs to their original timezone
- all disposable jobs are removed

## Cleanup Check

```bash
ssh horst-tailscale-openclaw '
  /home/openclaw/.npm-global/bin/openclaw cron list --all --json |
    node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const j=JSON.parse(s);const jobs=Array.isArray(j)?j:(j.jobs||j.items||[]);console.log(jobs.filter(job=>JSON.stringify(job).includes(\"ctm-e2e-\")).length)})"
'
```

The cleanup count should be `0`.
