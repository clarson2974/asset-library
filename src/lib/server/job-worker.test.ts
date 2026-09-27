import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the mocked AI returns; tests switch it between the upload and the job run.
const aiOutput = vi.hoisted(() => ({ tag: "upload-tag", description: "Upload description" }));

vi.mock("$lib/server/ai", () => ({
  generateAutoMetadata: vi.fn(async (params: { existingTags: string[] }) => ({
    tags: [...params.existingTags, aiOutput.tag],
    description: aiOutput.description,
  })),
}));

let dataRoot = "";
let cleanup: Array<() => void> = [];

async function loadModules() {
  process.env.ASSET_LIBRARY_DATA_DIR = dataRoot;
  vi.resetModules();
  const assets = await import("$lib/server/assets");
  const jobs = await import("$lib/server/jobs");
  const worker = await import("$lib/server/job-worker");
  cleanup = [assets.resetStorageForTests, jobs.resetJobsForTests];
  return { assets, jobs, worker };
}

async function runOne(modules: Awaited<ReturnType<typeof loadModules>>) {
  return modules.jobs.runNextJob(modules.worker.handleJob);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "asset-library-jobs-test-"));
});

afterEach(async () => {
  for (const reset of cleanup) reset();
  cleanup = [];
  delete process.env.ASSET_LIBRARY_DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("background job worker", () => {
  it("regenerates AI metadata but never overwrites user-curated metadata", async () => {
    const modules = await loadModules();
    const curated = await modules.assets.saveAsset({
      title: "Curated",
      tags: [],
      fileName: "curated.glsl",
      mimeType: "text/plain",
      size: 7,
      bytes: new TextEncoder().encode("curated"),
    });
    await modules.assets.updateAssetMetadata(curated.id, {
      title: "Curated",
      description: "Written by a person",
      tags: ["fx"],
      licenses: ["Unknown"],
      sourceUrl: "",
    });
    const generated = await modules.assets.saveAsset({
      title: "Shader",
      tags: [],
      fileName: "glow.glsl",
      mimeType: "text/plain",
      size: 4,
      bytes: new TextEncoder().encode("void"),
    });
    expect(generated.description).toBe("Upload description");

    aiOutput.tag = "regen-tag";
    aiOutput.description = "Regenerated description";
    modules.jobs.enqueueJob({ type: "ai-tagging", assetId: curated.id });
    modules.jobs.enqueueJob({ type: "ai-tagging", assetId: generated.id });
    await expect(runOne(modules)).resolves.toMatchObject({ status: "completed" });
    await expect(runOne(modules)).resolves.toMatchObject({ status: "completed" });

    expect((await modules.assets.getAssetById(curated.id))?.description).toBe("Written by a person");
    const updated = await modules.assets.getAssetById(generated.id);
    expect(updated?.description).toBe("Regenerated description");
    expect(updated?.tags).toContain("regen-tag");
    expect(updated?.metadataEdited).toBe(false);
    // The search index must reflect the new tags.
    await expect(modules.assets.searchAssets({ query: "Regenerated" })).resolves.toMatchObject({ total: 1 });
  });

  it("recomputes file hashes after the file changes on disk", async () => {
    const modules = await loadModules();
    const record = await modules.assets.saveAsset({
      title: "Notes",
      tags: [],
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 3,
      bytes: new TextEncoder().encode("one"),
    });
    await writeFile(modules.assets.getStoredFilePath(record.storedName), "two");

    modules.jobs.enqueueJob({ type: "hash", assetId: record.id });
    await expect(runOne(modules)).resolves.toMatchObject({ status: "completed", progress: 100 });

    const updated = await modules.assets.getAssetById(record.id);
    expect(updated?.hash).not.toBe(record.hash);
    expect(updated?.files[0].hash).toBe(updated?.hash);
  });

  it("refreshes file metadata from the stored file header", async () => {
    const modules = await loadModules();
    const record = await modules.assets.saveAsset({
      title: "Albedo",
      tags: [],
      fileName: "Rock_BaseColor.txt",
      mimeType: "text/plain",
      size: 4,
      bytes: new TextEncoder().encode("rock"),
    });

    modules.jobs.enqueueJob({ type: "metadata", assetId: record.id });
    await expect(runOne(modules)).resolves.toMatchObject({ status: "completed" });
    const updated = await modules.assets.getAssetById(record.id);
    expect(updated?.files[0].metadata).toMatchObject({ kind: "text", format: "txt" });
  });

  it("retries and then fails jobs for missing assets", async () => {
    const modules = await loadModules();
    modules.jobs.enqueueJob({ type: "hash", assetId: "missing", maxAttempts: 2 });

    await expect(runOne(modules)).resolves.toMatchObject({ status: "retrying", error: "Asset not found." });
    await expect(runOne(modules)).resolves.toMatchObject({ status: "failed", attempts: 2 });
  });
});
