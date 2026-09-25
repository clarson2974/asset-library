import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  it("detects PBR texture sets and extracts file metadata", async () => {
    const assets = await loadAssetsModule();

    expect(assets.detectPbrTextureSet("Hero_BaseColor.png")).toMatchObject({
      kind: "baseColor",
    });
    expect(assets.detectPbrTextureSet("Hero_Normal.png")).toMatchObject({
      kind: "normal",
    });
    expect(assets.detectPbrTextureSet("Hero_ORM.png")).toMatchObject({
      kind: "orm",
    });

    const wavBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x28, 0x00, 0x00, 0x00, // file size (40 bytes payload)
      0x57, 0x41, 0x56, 0x45, // WAVE
      0x66, 0x6d, 0x74, 0x20, // fmt
      0x10, 0x00, 0x00, 0x00, // chunk size
      0x01, 0x00, // PCM
      0x02, 0x00, // stereo
      0x44, 0xac, 0x00, 0x00, // sample rate 44100
      0x88, 0x58, 0x01, 0x00, // byte rate 176400
      0x02, 0x00, // block align
      0x10, 0x00, // bits per sample = 16
      0x64, 0x61, 0x74, 0x61, // data
      0x08, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);

    const metadata = assets.extractAssetFileMetadata({
      fileName: "sfx.wav",
      mimeType: "audio/wav",
      bytes: wavBytes,
      category: "audio",
    });

    expect(metadata).toMatchObject({
      kind: "audio",
      format: "wav",
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
    });
  });

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

  it("searches and paginates the catalog without returning soft-deleted assets", async () => {
    const assets = await loadAssetsModule();
    await assets.saveAsset({
      title: "Forest oak tree",
      description: "A detailed environment prop",
      tags: ["nature"],
      fileName: "oak.txt",
      mimeType: "text/plain",
      size: 3,
      bytes: new TextEncoder().encode("oak"),
    });
    const second = await assets.saveAsset({
      title: "Stone wall",
      tags: ["architecture"],
      fileName: "wall.txt",
      mimeType: "text/plain",
      size: 4,
      bytes: new TextEncoder().encode("wall"),
    });

    await expect(assets.searchAssets({ query: "oak", pageSize: 1 })).resolves.toMatchObject({
      total: 1,
      assets: [{ title: "Forest oak tree" }],
    });
    await assets.setAssetDeleted(second.id, true);
    await expect(assets.searchAssets({ pageSize: 1 })).resolves.toMatchObject({
      total: 1,
      totalPages: 1,
    });
  });

  it("supports multiple files and replaces only the selected child file", async () => {
    const assets = await loadAssetsModule();
    const record = await assets.saveAsset({
      title: "Character pack",
      tags: [],
      fileName: "hero.blend",
      mimeType: "application/octet-stream",
      size: 5,
      bytes: new TextEncoder().encode("blend"),
    });

    const texture = await assets.addAssetFile(record.id, {
      fileName: "hero_basecolor.png",
      mimeType: "image/png",
      size: 7,
      bytes: new TextEncoder().encode("texture"),
      role: "texture",
      variant: "4k",
    });
    expect(texture).toMatchObject({
      assetId: record.id,
      role: "texture",
      variant: "4k",
    });

    const before = await assets.getAssetById(record.id);
    expect(before?.files).toHaveLength(2);
    const source = before?.files.find((file) => file.role === "source");
    expect(source).toBeDefined();

    const replacement = await assets.replaceAssetChildFile(record.id, texture!.id, {
      fileName: "hero_basecolor_v2.png",
      mimeType: "image/png",
      size: 9,
      bytes: new TextEncoder().encode("texture-v2"),
      role: "texture",
      variant: "4k",
    });

    expect(replacement).toMatchObject({
      id: texture!.id,
      originalName: "hero_basecolor_v2.png",
    });
    const after = await assets.getAssetById(record.id);
    expect(after?.files).toHaveLength(2);
    expect(after?.files.find((file) => file.role === "source")).toMatchObject({
      id: source!.id,
      originalName: "hero.blend",
    });
    expect(after?.files.find((file) => file.id === texture!.id)).toMatchObject({
      originalName: "hero_basecolor_v2.png",
    });

    await expect(assets.deleteAsset(record.id)).resolves.toBe(true);
    await expect(readFile(assets.getStoredFilePath(source!.storedName))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(assets.getStoredFilePath(texture!.storedName))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stores logical asset relationships", async () => {
    const assets = await loadAssetsModule();
    const pack = await assets.saveAsset({
      title: "Pack",
      tags: [],
      fileName: "pack.txt",
      mimeType: "text/plain",
      size: 4,
      bytes: new TextEncoder().encode("pack"),
    });
    const member = await assets.saveAsset({
      title: "Member",
      tags: [],
      fileName: "member.txt",
      mimeType: "text/plain",
      size: 6,
      bytes: new TextEncoder().encode("member"),
    });

    await expect(assets.addAssetRelation(pack.id, member.id, "contains")).resolves.toBe(true);
    await expect(assets.listAssetRelations(pack.id)).resolves.toEqual([
      { parentAssetId: pack.id, childAssetId: member.id, relationType: "contains" },
    ]);
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

  it("tracks schema migrations and does not reapply completed migrations", async () => {
    const assets = await loadAssetsModule();
    await assets.saveAsset({
      title: "Migration asset",
      tags: ["migration"],
      fileName: "migration.txt",
      mimeType: "text/plain",
      size: 7,
      bytes: new TextEncoder().encode("versioned"),
    });

    const database = new DatabaseSync(path.join(dataRoot, "assets.db"));
    const migrationRows = database
      .prepare("SELECT id FROM schema_migrations ORDER BY applied_at ASC")
      .all() as Array<{ id: string }>;
    expect(migrationRows.length).toBeGreaterThan(0);
    expect(migrationRows.map((row) => row.id)).toContain("001_initial_assets_schema");
    database.close();

    await expect(assets.getDatabaseHealth()).resolves.toMatchObject({ ok: true });

    resetStorage?.();
    const assetsAgain = await loadAssetsModule();
    const databaseAgain = new DatabaseSync(path.join(dataRoot, "assets.db"));
    const migrationRowsAgain = databaseAgain
      .prepare("SELECT id FROM schema_migrations ORDER BY applied_at ASC")
      .all() as Array<{ id: string }>;
    expect(migrationRowsAgain).toHaveLength(migrationRows.length);
    await expect(assetsAgain.readAssets()).resolves.toHaveLength(1);
    databaseAgain.close();
    resetStorage?.();
  });

  it("links external assets without copying the source file, and never deletes it from disk", async () => {
    const assets = await loadAssetsModule();

    const externalDir = await mkdtemp(path.join(os.tmpdir(), "asset-library-external-"));
    const sourcePath = path.join(externalDir, "hero.txt");
    await writeFile(sourcePath, "external source content");

    try {
      const hash = await assets.computeFileHash(sourcePath);
      const record = await assets.saveExternalAsset({
        title: "Hero",
        tags: [],
        licenses: ["Unknown"],
        fileName: "hero.txt",
        mimeType: "text/plain",
        size: 24,
        absolutePath: sourcePath,
        hash,
      });

      expect(record.storageMode).toBe("external");

      const location = await assets.getAssetDiskLocation(record.id);
      expect(location).toEqual({ mode: "external", path: sourcePath });

      // No managed copy should exist in uploads/.
      const view = assets.toAssetView(await assets.getAssetById(record.id) as NonNullable<Awaited<ReturnType<typeof assets.getAssetById>>>);
      expect(view).not.toHaveProperty("externalPath");
      expect((view as unknown as Record<string, unknown>).storageMode).toBe("external");

      await expect(assets.deleteAsset(record.id)).resolves.toBe(true);
      // The source file must still exist after deleting the library entry.
      await expect(readFile(sourcePath, "utf8")).resolves.toEqual("external source content");
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });
});