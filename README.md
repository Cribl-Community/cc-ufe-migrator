# UFE Migrator

A Cribl App Platform application that assists with viewing `serverclass.conf` and migrating Splunk Universal Forwarder monitor stanzas to Cribl Edge agents.

## What it does

- **Customer profiles** — create and manage per-customer migration profiles, with progress persisted to the app's scoped Cribl KV store.
- **Archive ingestion** — upload a `deployment-apps` archive (`.zip`, `.tar`, `.tgz`, or `.tar.gz`) and a `serverclass.conf` file directly in the browser.
- **Parsing & review** — parses server classes and monitor stanzas from the uploaded artifacts for review.
- **Export** — produces configuration suitable for migrating monitor inputs to Edge agents.

The app runs inside a sandboxed iframe on the Cribl App Platform. All Cribl API calls are transparently proxied through the parent window (authentication is injected by the platform — the app never handles auth tokens). See [AGENTS.md](AGENTS.md) for platform details.

## Current Limitations

- **File monitors only** — the migrator currently supports migrating file monitor inputs (`[monitor://...]`) only. Other Universal Forwarder input types (e.g. network inputs, scripted inputs, WinEventLog) are not yet handled.

## Tech stack

- React 19 + TypeScript
- Vite
- React Router
- `jszip` / `fflate` for client-side archive extraction

## Development

```bash
npm install
npm run dev        # start the Vite dev server
npm run lint       # run ESLint
npm run build      # type-check and build to dist/
npm run package    # build and package the app for the Cribl App Platform
```

## Installing into Cribl (Import from Git)

The built app is committed to `main` under `static/` (the app bundle) and `default/`
(pack config), so Cribl's **Import from Git** can serve it directly from the default branch.

> **Important:** `static/` is build output. It does **not** update automatically when you
> change source under `src/`. After any source change, rebuild and re-commit the pack layout,
> otherwise `main` will serve a stale build:
>
> ```bash
> npm run build
> node scripts/prepare-git-pack.mjs --version 1.0.0
> git add -f static default && git commit -m "Rebuild static" && git push
> ```

For tagged releases, pushing a `vX.Y.Z` tag triggers the release workflow
(`.github/workflows/release.yml`), which regenerates the pack layout, publishes a GitHub
release, and moves the `latest` tag. Import a specific `vX.Y.Z` tag (or `latest`) if your
Cribl import lets you pin a ref.

## Project structure

```
config/proxies.yml      External domain declarations for the platform proxy
src/pages/              Landing page and profile view routes
src/components/         Modals and the KV store panel
src/lib/                KV store, profile, archive, and serverclass parsing logic
scripts/                Packaging and pack-layout scripts
static/                 Built app bundle (generated — committed for Git import)
default/                Pack config (generated — committed for Git import)
```
