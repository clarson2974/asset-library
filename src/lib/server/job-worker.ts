import {
  computeFileHash,
  extractAssetFileMetadata,
  getAssetById,
  getAssetDiskLocation,
  getAssetFileDiskLocationById,
  getAutoMetadataReadSize,
  regenerateAssetAiMetadata,
  setAssetFileHash,
  setAssetFileMetadata,
} from "$lib/server/assets";
import { readAssetBytes, readAssetHead, resolveAssetReadPath } from "$lib/server/asset-file-io";
import {
  recoverInterruptedJobs,
  runNextJob,
  updateJobProgress,
  type JobRecord,
  type JobType,
} from "$lib/server/jobs";

// Job types that have a handler. "preview" is reserved until thumbnail generation exists.
export const RUNNABLE_JOB_TYPES: JobType[] = ["hash", "metadata", "ai-tagging"];

const WORKER_CONCURRENCY = 2;
const WORKER_POLL_INTERVAL_MS = 2_000;
// Metadata extraction only parses headers (e.g. WAV fmt chunks), so large files are never read in full.
const METADATA_HEAD_BYTES = 65_536;
const TEXT_SNIPPET_BYTES = 4_000;

async function requireAsset(assetId: string | undefined) {
  if (!assetId) throw new Error("Job has no asset id.");
  const asset = await getAssetById(assetId);
  if (!asset) throw new Error("Asset not found.");
  return asset;
}

async function requireFileLocation(fileId: string) {
  const location = await getAssetFileDiskLocationById(fileId);
  if (!location) throw new Error(`Asset file ${fileId} not found.`);
  return location;
}

async function runHashJob(job: JobRecord, signal: AbortSignal): Promise<void> {
  const asset = await requireAsset(job.assetId);
  for (const [index, file] of asset.files.entries()) {
    if (signal.aborted) return;
    const hash = await computeFileHash(await resolveAssetReadPath(await requireFileLocation(file.id)));
    if (hash !== file.hash) await setAssetFileHash(file.id, hash);
    updateJobProgress(job.id, ((index + 1) / asset.files.length) * 100);
  }
}

async function runMetadataJob(job: JobRecord, signal: AbortSignal): Promise<void> {
  const asset = await requireAsset(job.assetId);
  for (const [index, file] of asset.files.entries()) {
    if (signal.aborted) return;
    const bytes = await readAssetHead(await requireFileLocation(file.id), METADATA_HEAD_BYTES);
    const extracted = extractAssetFileMetadata({
      fileName: file.originalName,
      mimeType: file.mimeType,
      bytes,
      category: file.category,
    });
    await setAssetFileMetadata(file.id, { ...file.metadata, ...extracted });
    updateJobProgress(job.id, ((index + 1) / asset.files.length) * 100);
  }
}

async function runAiTaggingJob(job: JobRecord): Promise<void> {
  const asset = await requireAsset(job.assetId);
  if (asset.metadataEdited) return;

  const readSize = getAutoMetadataReadSize(asset);
  let bytes: Uint8Array = new Uint8Array();
  if (readSize !== "none") {
    const location = await getAssetDiskLocation(asset.id);
    if (!location) throw new Error("Asset file not found.");
    bytes = readSize === "full"
      ? new Uint8Array(await readAssetBytes(location))
      : await readAssetHead(location, TEXT_SNIPPET_BYTES);
  }
  const outcome = await regenerateAssetAiMetadata(asset.id, bytes);
  if (outcome === "not-found") throw new Error("Asset not found.");
}

export async function handleJob(job: JobRecord, signal: AbortSignal): Promise<void> {
  switch (job.type) {
    case "hash":
      return runHashJob(job, signal);
    case "metadata":
      return runMetadataJob(job, signal);
    case "ai-tagging":
      return runAiTaggingJob(job);
    default:
      throw new Error(`No handler for job type "${job.type}".`);
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

// Claims up to WORKER_CONCURRENCY queued jobs. runNextJob claims synchronously before its first await,
// so the calls below never pick the same job, and extra calls return immediately once the limit is hit.
export function wakeJobWorker(): void {
  for (let slot = 0; slot < WORKER_CONCURRENCY; slot += 1) {
    void runNextJob(handleJob, WORKER_CONCURRENCY)
      .then((finished) => {
        // Keep draining while work remains instead of waiting for the next poll.
        if (finished) wakeJobWorker();
      })
      .catch((errorValue) => {
        console.error("[job-worker] failed to run job", {
          error: errorValue instanceof Error ? errorValue.message : String(errorValue),
        });
      });
  }
}

export function startJobWorker(): void {
  if (pollTimer) return;
  const recovered = recoverInterruptedJobs();
  if (recovered > 0) {
    console.info(`[job-worker] requeued ${recovered} job(s) interrupted by the last shutdown`);
  }
  pollTimer = setInterval(wakeJobWorker, WORKER_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  wakeJobWorker();
}

export function stopJobWorker(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}
