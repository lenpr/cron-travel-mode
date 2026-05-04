# ClawHub Publishing

This repository is laid out as a ClawHub-ready OpenClaw code plugin. The runtime entry point is built to `dist/index.js`, and package metadata points OpenClaw installs at that built file through `openclaw.runtimeExtensions`.

## Requirements

- Node.js 22 or newer.
- OpenClaw `2026.5.2` or newer.
- `clawhub` CLI installed or available from this repository's dev dependencies.
- A ClawHub account that can publish packages. ClawHub uses GitHub sign-in and requires the GitHub account to be at least one week old.

## Local Preflight

Run the full local validation before publishing:

```bash
npm ci
npm run check
npm run pack:dry-run
npm run clawhub:dry-run
```

`npm run check` typechecks, runs unit tests, and builds `dist/`. `npm run pack:dry-run` verifies the npm-pack payload. `npm run clawhub:dry-run` asks ClawHub to validate the folder publish plan without uploading a release.

Run release dry-runs from a clean committed tree. The command records Git source metadata from `HEAD`, so an uncommitted working tree is useful for iteration but not sufficient as a final release proof.

## Publish From GitHub

Publish after the target commit is pushed to the public GitHub repository:

```bash
clawhub login
clawhub package publish lenpr/cron-travel-mode --dry-run
clawhub package publish lenpr/cron-travel-mode
```

For a tagged release, publish the tag explicitly:

```bash
git tag v0.1.0
git push origin v0.1.0
clawhub package publish lenpr/cron-travel-mode@v0.1.0 --dry-run
clawhub package publish lenpr/cron-travel-mode@v0.1.0
```

## Publish A Local ClawPack

For the most explicit artifact path, create an npm-pack tarball and upload that tarball:

```bash
npm run check
TARBALL=$(npm pack --silent)
clawhub package publish "$TARBALL" --family code-plugin --dry-run
clawhub package publish "$TARBALL" --family code-plugin
rm -f "$TARBALL"
```

Use this tarball route for the final release when you want the ClawHub artifact to match the exact npm-pack payload verified by `npm run pack:dry-run`.

## Install After Publication

Users install the plugin from ClawHub with:

```bash
openclaw plugins install clawhub:@lenpr/cron-travel-mode
openclaw plugins enable cron-travel-mode
openclaw gateway restart
openclaw plugins doctor
```

OpenClaw validates the package's advertised plugin API and gateway compatibility before installing it, so older hosts should fail before partially installing the plugin.

## Release Checklist

- Version in `package.json` and `openclaw.plugin.json` matches the intended release.
- `git status --short` is empty for the commit or tag being published.
- `CHANGELOG.md` or GitHub release notes summarize user-visible changes.
- `npm run check` passes locally.
- `npm run pack:dry-run` includes `dist/`, `src/`, `openclaw.plugin.json`, `README.md`, `LICENSE`, and `docs/`.
- `npm run clawhub:dry-run` succeeds.
- Optional real-host e2e passes with `OPENCLAW_BIN=/path/to/openclaw npm run test:e2e:openclaw`.
