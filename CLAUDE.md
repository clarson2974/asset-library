# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [AGENTS.md](AGENTS.md) first.** It is the authoritative guide for project shape, conventions, safety rules, and the change workflow; this file does not repeat it. The staged roadmap (migrations → auth/sessions → RBAC → audit log → multi-file assets → …) is in [docs/Kellojo-Asset-Library-Extension-Agent-Plan.md](docs/Kellojo-Asset-Library-Extension-Agent-Plan.md). The current branch work (`feature/auth-rbac`) targets its milestones 2–3.

## Commands

```text
npm ci             # install
npm run dev        # Vite dev server
npm run check      # svelte-kit sync + strict svelte-check (the only static validation)
npm run build      # production build via adapter-node -> build/
npm start          # run the built server (node build)
docker compose build
```

No test runner, linter, or formatter exists yet, so there is no "single test" command. Validate with `check` + `build` plus manual exercise of the affected flows.

Runtime requires a Node version that ships `node:sqlite` (`DatabaseSync`); the Docker image uses `node:25-alpine`.

## Architecture

Single-page SvelteKit app: a large `src/routes/+page.svelte` drives the entire UI and talks to JSON routes under `src/routes/api/` through `AssetLibraryApiService` (`src/lib/services/asset-library-api.ts`). There are no `+page.server.ts` loads; all data flows through the API.

**Storage (`src/lib/server/assets.ts`)** owns everything persistent:
- Paths are resolved from `process.cwd()/data`: `assets.db` (SQLite, WAL mode), `uploads/` (files stored as `<uuid><ext>`), and legacy `assets.json`, which is imported once into SQLite by `migrateLegacyJsonIfNeeded`.
- The schema is created inline in `getDb()` with `CREATE TABLE IF NOT EXISTS`. There is no migration system yet (roadmap Milestone 1). Arrays (`tags`, `licenses`) are stored as JSON text columns (`tags_json`, `licenses_json`), and `rowToAssetRecord`/`insertRecord` convert between snake_case rows and camelCase `AssetRecord`.
- `ensureStorage()` is a memoized init promise that every exported function awaits. `ensureAssetHashes()` backfills SHA-256 hashes for older rows.
- Duplicate detection is layered: an explicit hash lookup before writing, plus a `UNIQUE` index on `hash` as a race backstop. Both surface as `DuplicateAssetError`, which routes map to HTTP 409 with `{ duplicate: true, asset }`.
- Category and preview kind are derived by `getCategory`/`getPreviewKind` from extension sets at the top of the file (MIME is the fallback). Adding a file type means updating those sets and, if needed, the unions in `src/lib/types.ts`.
- `toAssetView` adds `fileUrl`/`downloadUrl`/`textPreviewUrl`. The API returns `AssetView`; the DB layer uses `AssetRecord`.

**Upload pipeline:** `POST /api/assets` (multipart) → `saveAsset` → hash/dup check → classify → image dimensions (`image-size`) → **synchronous AI call** (`generateAutoMetadata`) → write file → insert row, deleting the file if the insert fails. Whole files are buffered in memory. Uploads are parallelized client-side (`PUBLIC_UPLOAD_PARALLELISM`), and `BODY_SIZE_LIMIT` (default 1G in Docker) caps request size.

**AI (`src/lib/server/ai.ts`):** uses the Vercel AI SDK (`ai` + `@ai-sdk/openai`) against any OpenAI-compatible endpoint (for example LM Studio) with a zod-validated structured output of `{ tags, description }`. Config merges `data/ai-config.json` (auto-created with defaults) with `AI_*` env overrides from `$env/dynamic/private`; env wins. Texture and audio (wav/mp3 only) bytes and the first 4 KB of text files are sent as model input. AI output is sanitized (`sanitizeTag`, `sanitizeDescription`) before use.

**`metadataEdited` flag:** set when a user edits metadata (or supplies source/license at upload). It distinguishes user-curated metadata from AI-generated metadata and is reset by the file-replace flow, so preserve its semantics when touching update/replace paths. Note that `replaceAssetFile` currently writes the new file and deletes the old one *before* the DB `UPDATE`, so a failed update can leave a row pointing at a missing file.

**API routes:**
- `api/assets`: GET list / POST upload
- `api/assets/[id]`: PATCH metadata / DELETE
- `api/assets/[id]/file`: GET with manual HTTP `Range` support (needed for audio/model previews) / PATCH replace file
- `api/assets/[id]/download`: attachment download
- `api/assets/[id]/text`: text preview
- `api/integrations/ai`: GET/PATCH AI config

All endpoints are currently unauthenticated.

**Client previews:** `ThreeModelPreview` (three.js), `AudioPreview` (wavesurfer.js), and text via the `/text` route. Search is client-side fuzzy search (Fuse.js) over the full asset list returned by GET `/api/assets`.

## Deployment

The multi-stage `Dockerfile` builds with adapter-node and serves on port 3000. `docker-compose.yml` mounts `./data:/app/data`, and `ORIGIN` must match the public URL for SvelteKit's CSRF checks on form posts. The GitHub workflow `.github/workflows/docker-image.yaml` publishes to GHCR on every push, with the version taken from `v*` tags.
