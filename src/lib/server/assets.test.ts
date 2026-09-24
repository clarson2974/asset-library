import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/ai", () => ({
  generateAutoMetadata: vi.fn(async (params: { existingTags: string[]; existingDescription: string }) => ({
    tags: params.existingTags,
    description: params.existingDescription,
  })),
}));

let dataRoot = "";
let resetStorage: (() => void) | undefined;

async function loadAssetsModule() {
  process.env.ASSET_LIBRARY_DATA_DIR = dataRoot;
  vi.resetModules();
  const assets = await import("$lib/server/assets");
  resetStorage = assets.resetStorageForTests;
  return assets;
}

async function createTempDataRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "asset-library-test-"));
}

beforeEach(async () => {
  dataRoot = await createTempDataRoot();
});

afterEach(async () => {
  resetStorage?.();
  resetStorage = undefined;
  delete process.env.ASSET_LIBRARY_DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("asset storage", () => {
  it("saves an asset and reads its file from isolated storage", async () => {
    const assets = await loadAssetsModule();
    const record = await assets.saveAsset({
      title: "Test texture",
      tags: ["Environment"],
      fileName: "texture.txt",
      mimeType: "text/plain",
      size: 4,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    expect((await assets.readAssets()).map((item) => item.id)).toEqual([record.id]);
    await expect(readFile(assets.getStoredFilePath(record.storedName))).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("serves the stored bytes through the download handler", async () => {
    const assets = await loadAssetsModule();
    const record = await assets.saveAsset({
      title: "Downloadable asset",
      tags: [],
      fileName: "asset.bin",
      mimeType: "application/octet-stream",
      size: 3,
      bytes: new Uint8Array([9, 8, 7]),
    });
    const { GET } = await import("../../routes/api/assets/[id]/download/+server");

    const response = await GET({ params: { id: record.id } } as Parameters<
      typeof GET
    >[0]);

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).resolves.toEqual(
      new Uint8Array([9, 8, 7]).buffer,
    );
  });

  it("rejects duplicate file content by hash", async () => {
    const assets = await loadAssetsModule();
    const input = {
      title: "First",
      tags: [],
      fileName: "first.txt",
      mimeType: "text/plain",
      size: 5,
      bytes: new TextEncoder().encode("hello"),
    };

    const first = await assets.saveAsset(input);
    await expect(assets.saveAsset({ ...input, title: "Second", fileName: "second.txt" })).rejects.toMatchObject({
      name: "DuplicateAssetError",
      existingAsset: { id: first.id },
    });
  });

  it("updates metadata and deletes the asset file", async () => {
    const assets = await loadAssetsModule();
    const record = await assets.saveAsset({
      title: "Before",
      tags: [],
      licenses: ["CC0"],
      fileName: "script.js",
      mimeType: "text/javascript",
      size: 2,
      bytes: new TextEncoder().encode("ok"),
    });

    const updated = await assets.updateAssetMetadata(record.id, {
      title: "After",
      description: "Updated description",
      tags: ["updated"],
      licenses: ["CC BY 4.0"],
      sourceUrl: "https://example.test/source",
    });

    expect(updated).toMatchObject({
      id: record.id,
      title: "After",
      metadataEdited: true,
      tags: ["updated"],
    });
    await expect(assets.deleteAsset(record.id)).resolves.toBe(true);
    await expect(readFile(assets.getStoredFilePath(record.storedName))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(assets.getAssetById(record.id)).resolves.toBeUndefined();
  });

  it("rejects paths outside the managed uploads directory", async () => {
    const assets = await loadAssetsModule();

    expect(() => assets.getStoredFilePath("../assets.db")).toThrow(
      "escapes the uploads directory",
    );
  });

  it("migrates a legacy JSON record without touching the real data directory", async () => {
    const legacyRecord = {
      id: "legacy-id",
      title: "Legacy asset",
      description: "Imported",
      tags: ["legacy"],
      licenses: ["CC0"],
      sourceUrl: "",
      metadataEdited: true,
      uploadDate: "2026-01-01T00:00:00.000Z",
      originalName: "legacy.txt",
      storedName: "legacy-file.txt",
      fileType: "txt",
      hash: "legacy-hash",
      mimeType: "text/plain",
      size: 6,
      category: "script",
      previewKind: "text",
    } as const;
    await writeFile(path.join(dataRoot, "assets.json"), JSON.stringify([legacyRecord]));
    const assets = await loadAssetsModule();

    await expect(assets.getAssetById(legacyRecord.id)).resolves.toMatchObject({
      id: legacyRecord.id,
      title: legacyRecord.title,
      previewKind: "text",
    });
  });
});