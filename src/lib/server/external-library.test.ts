import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let baseDir = "";
let rootDir = "";

async function loadModule() {
  return import("$lib/server/external-library");
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), "asset-library-scan-test-"));
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

describe("external library scanning", () => {
  it("scans read-only library roots without following symlinks or escaping traversal", async () => {
    const { scanExternalLibraries, updateExternalLibraryConfig, resolveExternalLibraryPath } =
      await loadModule();

    await mkdir(path.join(rootDir, "assets", "models"), { recursive: true });
    await writeFile(path.join(rootDir, "assets", "models", "hero.glb"), "binary-glb");
    await writeFile(path.join(rootDir, "assets", "ignored.tmp"), "ignore-me");
    await symlink(path.join(rootDir, "assets", "models", "hero.glb"), path.join(rootDir, "assets", "models", "evil-link.glb"));

    await updateExternalLibraryConfig({
      enabled: true,
      rootDirectory: rootDir,
      roots: ["assets"],
      ignorePatterns: ["**/*.tmp"],
      supportedExtensions: [".glb"],
    });

    const scan = await scanExternalLibraries();

    expect(scan.discovered.map((entry) => entry.relativePath)).toContain("models/hero.glb");
    expect(scan.ignored.some((entry) => entry.relativePath === "ignored.tmp")).toBe(true);
    expect(scan.discovered.some((entry) => entry.relativePath === "models/evil-link.glb")).toBe(false);
    expect(() => resolveExternalLibraryPath(rootDir, "../escape.glb")).toThrow(
      "outside the configured root",
    );
  });

  it("reports missing files as unavailable and keeps source files unmodified", async () => {
    const { scanExternalLibraries, updateExternalLibraryConfig, getExternalLibraryScanState } =
      await loadModule();

    const trackedRoot = path.join(rootDir, "tracked");
    await mkdir(trackedRoot, { recursive: true });
    const filePath = path.join(trackedRoot, "tree.obj");
    await writeFile(filePath, "model-data");

    await updateExternalLibraryConfig({
      enabled: true,
      rootDirectory: rootDir,
      roots: ["tracked"],
      ignorePatterns: [],
      supportedExtensions: [".obj"],
    });

    const firstScan = await scanExternalLibraries();
    expect(firstScan.discovered).toHaveLength(1);

    await rm(filePath);
    const secondScan = await scanExternalLibraries();

    expect(secondScan.missing.some((entry) => entry.relativePath === "tree.obj")).toBe(true);
    expect(secondScan.status).toBe("warning");

    const state = await getExternalLibraryScanState();
    expect(state.lastScan?.status).toBe("warning");
  });
});
