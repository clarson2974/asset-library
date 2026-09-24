# Asset Library Agent Guide

## Project shape

- This is a SvelteKit 2 application using Svelte 5, TypeScript, Vite, and the Node adapter.
- The UI entry point is `src/routes/+page.svelte`.
- Reusable UI belongs in `src/lib/components/`; shared types belong in `src/lib/types.ts`.
- Browser-side API clients and helpers belong in `src/lib/services/`.
- Server-only code belongs in `src/lib/server/`. Keep Node filesystem, SQLite, crypto, and AI provider code out of client modules.
- SvelteKit API routes live under `src/routes/api/` and use file-based routing.
- Runtime state is stored under `data/`: SQLite metadata, AI configuration, and uploaded files. The directory is intentionally ignored by Git.
- `build/` is generated output. Edit `src/`, configuration, or static source files instead of compiled files.

For user-facing setup and configuration, see [README.md](README.md). For the staged security and extension roadmap, see [docs/Kellojo-Asset-Library-Extension-Agent-Plan.md](docs/Kellojo-Asset-Library-Extension-Agent-Plan.md).

## Commands

Run these from the repository root:

```text
npm ci
npm run check
npm run build
npm run dev
```

- `npm run check` runs `svelte-kit sync` and strict `svelte-check`.
- `npm run build` validates the production Vite/SvelteKit build.
- `npm test` runs the Vitest suite; tests use temporary storage and must not touch `data/`.
- There is currently no lint or formatter script. Do not claim coverage beyond the tests that exist.
- For deployment-oriented changes, also consider `docker compose build` and verify the persistent `data/` mount behavior.

Run `npm run check` and `npm run build` after changes that affect application code, routes, configuration, or types. Keep generated build artifacts and runtime data out of commits.

See [TESTING.md](TESTING.md) for test isolation and current coverage. Add focused tests for storage, API validation, migrations, and authorization as those areas evolve.

## Local conventions

- Use TypeScript with strict checking and `$lib` imports.
- Use Svelte component composition and the existing components in `src/lib/components/` before adding new UI primitives.
- Use camelCase for TypeScript names and snake_case only for SQLite column names. Preserve the existing `AssetRecord`/`AssetView` types at API boundaries.
- Asset categories and preview kinds are constrained unions in `src/lib/types.ts`; extend those types and the related server/client mappings together.
- File extensions determine most asset classification and preview behavior; MIME type is the fallback for unknown files.
- Asset IDs and stored filenames are UUIDs. Preserve hash-based duplicate detection and never derive storage paths directly from user-provided names.
- API handlers return JSON error payloads with appropriate 4xx/5xx status codes. Keep duplicate uploads distinguishable from general failures.
- Normalize and validate user and AI metadata at the server boundary. Treat AI output as untrusted input.

## Safety and scope

- Authentication and authorization are not implemented yet. All current endpoints are public; do not imply that the application is safe for internet exposure.
- Protect path resolution, upload handling, replacement, deletion, and download/preview routes against traversal, arbitrary filesystem access, oversized input, and partial writes.
- Never commit `.env`, API keys, session secrets, `data/`, uploaded assets, database files, or generated output.
- Preserve existing user data when changing the SQLite schema. Add an explicit migration and backup/rollback notes before changing persisted structures; do not rely on startup schema creation as a migration system.
- Keep changes focused and compatible with the upstream project where practical. Do not modify unrelated generated files or refactor broad areas without a task requirement.

## Change workflow

1. Inspect the owning route, service, server module, or component and its neighboring call sites before editing.
2. Keep server-only and browser-only dependencies on their respective sides of the SvelteKit boundary.
3. Update shared types and all affected serialization/deserialization paths together.
4. Validate with `npm run check` and `npm run build`; manually exercise upload, duplicate detection, preview, metadata edit, replace, and delete flows when those paths change.
5. Report missing automated coverage clearly and add focused tests for new behavior, especially storage, API validation, migrations, and authorization.