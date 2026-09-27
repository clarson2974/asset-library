# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [AGENTS.md](AGENTS.md) first** for project shape, conventions, safety rules, and the change workflow; this file does not repeat them. The staged roadmap is in [docs/Kellojo-Asset-Library-Extension-Agent-Plan.md](docs/Kellojo-Asset-Library-Extension-Agent-Plan.md).

## Commands

```text
npm ci                          # install
npm run dev                     # Vite dev server on http://localhost:5173
npm test                        # Vitest, all src/**/*.test.ts
npx vitest run src/lib/server/auth.test.ts        # single file
npx vitest run -t "rejects duplicate"             # single test by name
npm run check                   # svelte-kit sync + strict svelte-check
npm run build                   # adapter-node build -> build/
npm start                       # run the built server (node build)
docker compose build
```

CI (`.github/workflows/test.yml`) runs `npm test`, `check`, `build`, and a Docker build on every push and PR. There is no linter or formatter.

Runtime needs a Node version that ships `node:sqlite` (`DatabaseSync`); CI and the Docker image use Node 25.

## Architecture

Single-page SvelteKit app: `src/routes/+page.svelte` (large) drives the whole UI and talks to JSON routes under `src/routes/api/` through `AssetLibraryApiService` (`src/lib/services/asset-library-api.ts`). There is also a `/login` page. No `+page.server.ts` loads exist; all data flows through the API.

### Data directory and test isolation

Every server module resolves its data root independently as `ASSET_LIBRARY_DATA_DIR` or else `process.cwd()/data`. That root holds `assets.db` (SQLite, WAL), `uploads/`, `ai-config.json`, `external-library-config.json`, `external-library-scan-state.json`, `external-library-import-state.json`, `.backups/`, and legacy `assets.json`. Tests set `ASSET_LIBRARY_DATA_DIR` to a temp dir and use the `reset*ForTests()` exports (`resetStorageForTests`, `resetAuthStorageForTests`, `resetJobsForTests`) to drop cached DB handles. Any new module that opens the DB must follow the same pattern so tests never touch real `data/`. After `vi.resetModules()`, close every module instance's handle before deleting the temp dir, or Windows fails with `EBUSY`.

### Storage and migrations (`src/lib/server/assets.ts`)

- Three modules open their own `DatabaseSync` on the same `assets.db`: `assets.ts`, `auth.ts`, and `jobs.ts`.
- The versioned migrations are the `migrations` array in `assets.ts`, tracked in `schema_migrations`. They run inside `BEGIN IMMEDIATE` transactions, and pending migrations trigger a DB backup to `data/.backups/` (the newest 5 are kept).
- If the DB has an applied migration id the app doesn't recognize, startup refuses with an "unsafe downgrade" error. `002_auth_tables` is applied by `auth.ts` and whitelisted in `knownExternalMigrationIds`. A new migration in another module must be added there too.
- `jobs.ts` still creates `background_jobs` with inline `CREATE TABLE IF NOT EXISTS`, outside the migration system.
- **Logical assets with multiple files:**
  - An `assets` row is the logical asset (metadata).
  - `asset_files` holds its physical files, each with a `role`/`variant` and `metadata_json`. Migrated legacy files get the id `<assetId>:primary`.
  - `asset_relations` links parent and child assets.
  - The `assets` row still mirrors the primary file's columns (`stored_name`, `hash`, …).
- **Storage modes:** `storage_mode` on both tables is `managed` (a copy in `uploads/<uuid><ext>`) or `external` (linked in place via `external_path`).
  - Always read file bytes through `readAssetBytes` (`asset-file-io.ts`). It re-validates external paths against the current library config on every read.
  - Delete and replace remove managed copies only, never external files.
- **Deletion:** `DELETE /api/assets/[id]` soft-deletes by setting `deleted_at`. `?permanent=1` hard-deletes. Listing excludes soft-deleted rows unless `includeDeleted=1`.
- **Search:** migration 004 added an FTS5 table, `assets_search`, kept current by `indexAsset()`. Any write that changes title, description, tags, or licenses must call it. `searchAssets()` backs `GET /api/assets`, which is paginated (`page`, `pageSize`, `q`, `category`, `tag`, `license`, `todo`, `sort`). Query terms are prefix-matched and AND'd; there is no typo tolerance.
- **Facets:** `getAssetFacets()` backs `GET /api/assets/facets`, which returns library-wide counts (total, todo, per category, tags, licenses) over non-deleted assets. Tag and license values are grouped case-insensitively.
- Arrays are stored as JSON text (`tags_json`, `licenses_json`). Row↔`AssetRecord` conversion uses snake_case↔camelCase. The API returns `AssetView` (built by `toAssetView`, which adds URLs).
- **Duplicates:** an explicit hash lookup plus unique hash indexes on both `assets` and `asset_files` raise `DuplicateAssetError`, which routes map to HTTP 409 `{ duplicate: true, asset }`.
- **Classification:** category and preview kind come from the extension sets at the top of `assets.ts`, with MIME as the fallback. `extractAssetFileMetadata`/`detectPbrTextureSet` add game-asset metadata. New file types require updating the sets and the unions in `src/lib/types.ts`.
- **`metadataEdited`** separates user-curated metadata from AI-generated metadata. It is reset by the file-replace flow; preserve its semantics in update and replace paths.

### Upload pipeline

`POST /api/assets` (multipart) → `saveAsset` → hash/duplicate check → classify → image dimensions → **synchronous AI call** (`generateAutoMetadata`) → write file → insert rows, deleting the file if the insert fails.

- Files are buffered fully in memory.
- The client uploads in parallel (`PUBLIC_UPLOAD_PARALLELISM`) through a queue that can be paused and resumed.
- `BODY_SIZE_LIMIT` caps request size.

### Auth and RBAC (`src/lib/server/auth.ts`, `src/hooks.server.ts`)

- `hooks.server.ts` requires a session cookie (`asset_library_session`) on everything except `PUBLIC_PATHS` (login, logout, me, health) and static paths. Unauthenticated API calls get 401; page requests are redirected to `/login`.
- On first run, an admin user is seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (default `admin@localhost` / `admin`). Passwords are hashed with PBKDF2.
- The roles are `admin`, `editor`, and `viewer`, mapped to capabilities in `ROLE_CAPABILITIES`: `asset.read|create|update|delete` and `settings.manage`.
- **Every API handler must start with `requireUserCapability(locals.user, "<capability>")` and return 403 on failure.** Integration and settings routes require `settings.manage`.

### External library import (`src/lib/server/external-library.ts`)

- Scans a configured root (`ASSET_LIBRARY_EXTERNAL_ROOT` or config) with ignore patterns and an extension allowlist.
- Guards against path traversal and symlink escapes with `resolveExternalLibraryPath` and `ensureNoSymlinkEscape`.
- Imports run in the background and link files in place through `saveExternalAsset`.
- Import progress (counters plus remaining paths) lives in module state and is snapshotted to `external-library-import-state.json`. Snapshots are atomic (temp file + rename) and throttled to about every 2 s, plus on start, pause, resume, and finish.
- On restart, an import that was running comes back **paused**; the user resumes it. Files finished after the last snapshot are re-hashed and skipped as duplicates.
- The UI loads the status on mount and polls `/api/integrations/external-library/import-status` while an import runs.

### Background jobs (`src/lib/server/jobs.ts`)

- `jobs.ts` is a SQLite-backed queue (`background_jobs`) with retry, cancel, and progress.
- `job-worker.ts` runs it:
  - `startJobWorker()` is called from the `init` hook in `hooks.server.ts`. It requeues jobs left `running` by a previous process, then polls every 2 s with concurrency 2.
  - `wakeJobWorker()` starts work immediately.
  - Handlers exist for `hash` (recompute file hashes), `metadata` (re-extract file metadata from the first 64 KB), and `ai-tagging` (regenerate tags and description, skipping `metadataEdited` assets). `preview` has no handler yet.
- `POST /api/jobs` takes `{ type, assetIds }` and queues one job per asset. `GET` lists jobs and `DELETE ?id=` cancels one.
- Nothing queues jobs automatically yet, and the UI has no jobs panel.
- `recoverInterruptedJobs()` must only run at worker startup. Calling it while the worker runs would requeue jobs that are still in progress.

### AI (`src/lib/server/ai.ts`)

- Uses the Vercel AI SDK against any OpenAI-compatible endpoint, with zod-validated `{ tags, description }` output.
- Config merges `data/ai-config.json` with `AI_*` env overrides (env wins).
- Sends texture and audio (wav/mp3) bytes and the first 4 KB of text files as model input.
- Output is sanitized (`sanitizeTag`, `sanitizeDescription`); treat it as untrusted.

### Client

- `+page.svelte` sends search (debounced 250 ms), filters, and sort to `GET /api/assets` and shows results in server order. It pages with "Load more", discards responses from superseded queries, and fills the filter pane from `/api/assets/facets`.
- Previews: `ThreeModelPreview` (three.js), `AudioPreview` (wavesurfer.js), and text via the `/text` routes.
- File routes serve HTTP `Range` requests manually, which the audio and model previews need.

## Deployment

The multi-stage `Dockerfile` builds with adapter-node and serves on port 3000. `docker-compose.yml` mounts `./data:/app/data`. `ORIGIN` must match the public URL for SvelteKit's CSRF checks. Set `ADMIN_EMAIL`/`ADMIN_PASSWORD` before first start, or change the default admin credentials. `.github/workflows/docker-image.yaml` publishes to GHCR on every push, with versions taken from `v*` tags.
