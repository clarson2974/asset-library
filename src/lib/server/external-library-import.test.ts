import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let baseDir = "";
let rootDir = "";

async function loadModule() {
  return import("$lib/server/external-library");
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "asset-library-import-test-"));
  rootDir = path.join(baseDir, "library-root");
  await mkdir(rootDir, { recursive: true });
  process.env.ASSET_LIBRARY_DATA_DIR = baseDir;
  process.env.ASSET_LIBRARY_EXTERNAL_ROOT = rootDir;
});

afterEach(async () => {
  delete process.env.ASSET_LIBRARY_DATA_DIR;
  delete process.env.ASSET_LIBRARY_EXTERNAL_ROOT;
  await rm(baseDir, { recursive: true, force: true });
});

async function setupScannedLibrary(
  module: Awaited<ReturnType<typeof loadModule>>,
  fileNames: string[],
): Promise<string[]> {
  await module.updateExternalLibraryConfig({
    enabled: true,
    rootDirectory: rootDir,
    roots: ["."],
    ignorePatterns: [],
    supportedExtensions: [".glb"],
  });

  for (const name of fileNames) {
    await mkdir(path.dirname(path.join(rootDir, name)), { recursive: true });
    await writeFile(path.join(rootDir, name), `binary-${name}`);
  }

  await module.scanExternalLibraries();
  const state = await module.getExternalLibraryScanState();
  return (state.lastScan?.discovered ?? []).map((e) => e.relativePath);
}

describe("external library import pause/resume", () => {
  it("rejects pause when no import is running", async () => {
    const mod = await loadModule();
    expect(() => mod.pauseExternalLibraryImport()).toThrow(
      "No import is currently running.",
    );
  });

  it("rejects resume when no import is paused", async () => {
    const mod = await loadModule();
    expect(() => mod.resumeExternalLibraryImport()).toThrow(
      "No paused import to resume.",
    );
  });

  it("rejects starting a second import while one is running", async () => {
    const mod = await loadModule();
    const paths = await setupScannedLibrary(mod, ["a.glb", "b.glb"]);

    mod.startExternalLibraryImport(paths);
    expect(() => mod.startExternalLibraryImport(paths)).toThrow(
      "An import is already in progress.",
    );

    // Wait for the background loop to finish.
    while (mod.getExternalLibraryImportStatus().running) {
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  it("marks the job as paused and keeps running true", async () => {
    const mod = await loadModule();
    // Many files so the loop is still active when we pause.
    const paths = await setupScannedLibrary(
      mod,
      Array.from({ length: 50 }, (_, i) => `file-${i}.glb`),
    );

    mod.startExternalLibraryImport(paths);

    // Wait until the loop has started processing.
    while (mod.getExternalLibraryImportStatus().processed === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const status = mod.pauseExternalLibraryImport();
    expect(status.paused).toBe(true);
    expect(status.pausedAt).not.toBeNull();
    expect(status.running).toBe(true);

    // Wait for the in-flight file to finish so the loop exits.
    while (mod.getExternalLibraryImportStatus().currentFile !== null) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const settled = mod.getExternalLibraryImportStatus();
    expect(settled.paused).toBe(true);
    expect(settled.running).toBe(true);
    expect(settled.processed).toBeLessThan(settled.total);

    // Resume and wait for completion.
    mod.resumeExternalLibraryImport();
    while (mod.getExternalLibraryImportStatus().running) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const done = mod.getExternalLibraryImportStatus();
    expect(done.running).toBe(false);
    expect(done.paused).toBe(false);
    expect(done.processed).toBe(done.total);
    expect(done.imported).toBeGreaterThan(0);
  });
});