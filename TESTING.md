# Testing

Run the automated suite with:

```text
npm test
```

Tests use Vitest and temporary directories under the operating system's temp location. They set `ASSET_LIBRARY_DATA_DIR` so the real `data/` directory is never used. AI metadata generation is mocked in storage tests.

The current suite covers:

- Asset storage: creation, duplicate hash rejection, metadata updates, soft and permanent deletion, multi-file assets and relations, managed path containment, and legacy JSON migration.
- Search and filter facets.
- Authentication, sessions, and role capabilities.
- External library scanning (traversal and symlink guards) and import pause, resume, and restart recovery.
- Background job handlers (hash, metadata, AI tagging) and retry/failure behavior.

Modules cache their SQLite handle, so tests that call `vi.resetModules()` must close each instance with its `reset*ForTests()` export before deleting the temp directory; otherwise Windows fails with `EBUSY`.

Browser and end-to-end coverage is not configured yet; add Playwright for the authenticated UI flows.