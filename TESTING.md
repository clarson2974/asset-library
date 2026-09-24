# Testing

Run the automated suite with:

```text
npm test
```

Tests use Vitest and temporary directories under the operating system's temp location. They set `ASSET_LIBRARY_DATA_DIR` so the real `data/` directory is never used. AI metadata generation is mocked in storage tests.

The current suite covers asset creation, duplicate hash rejection, metadata updates, deletion, managed path containment, and legacy JSON migration. Browser and end-to-end coverage is not configured yet; add Playwright when a stable authenticated workflow exists.

The application currently has no authentication or authorization. Do not expose it to an untrusted network while those milestones remain incomplete.