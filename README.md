# UFE Migrator

A Cribl App Platform application that assists with viewing `serverclass.conf` and migrating Splunk Universal Forwarder monitor stanzas to Cribl Edge agents.

## What it does

- **Customer profiles** — create and manage per-customer migration profiles, with progress persisted to the app's scoped Cribl KV store.
- **Archive ingestion** — upload a `deployment-apps` archive (`.zip`, `.tar`, `.tgz`, or `.tar.gz`) and a `serverclass.conf` file directly in the browser.
- **Parsing & review** — parses server classes and monitor stanzas from the uploaded artifacts for review.
- **Export** — produces configuration suitable for migrating monitor inputs to Edge agents.

The app runs inside a sandboxed iframe on the Cribl App Platform. All Cribl API calls are transparently proxied through the parent window (authentication is injected by the platform — the app never handles auth tokens). See [AGENTS.md](AGENTS.md) for platform details.

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

## Project structure

```
config/proxies.yml      External domain declarations for the platform proxy
src/pages/              Landing page and profile view routes
src/components/         Modals and the KV store panel
src/lib/                KV store, profile, archive, and serverclass parsing logic
scripts/                Packaging scripts
```
