import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JobType = "hash" | "metadata" | "ai-tagging" | "preview";
export type JobStatus = "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";
export type JobRecord = {
  id: string;
  type: JobType;
  assetId?: string;
  status: JobStatus;
  progress: number;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  type: JobType;
  asset_id: string | null;
  status: JobStatus;
  progress: number;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const dataRoot = path.resolve(process.env.ASSET_LIBRARY_DATA_DIR?.trim() || path.join(process.cwd(), "data"));
const dbPath = path.join(dataRoot, "assets.db");
let database: DatabaseSync | undefined;
let activeWorkers = 0;

function getDb(): DatabaseSync {
  if (database) return database;
  database = new DatabaseSync(dbPath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      asset_id TEXT,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status, created_at);
  `);
  return database;
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    assetId: row.asset_id ?? undefined,
    status: row.status,
    progress: Number(row.progress),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function resetJobsForTests(): void {
  database?.close();
  database = undefined;
  activeWorkers = 0;
}

export function enqueueJob(input: { type: JobType; assetId?: string; maxAttempts?: number }): JobRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO background_jobs (id, type, asset_id, status, progress, attempts, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, ?)
  `).run(id, input.type, input.assetId ?? null, Math.max(1, Math.min(10, input.maxAttempts ?? 3)), now, now);
  return getJob(id)!;
}

export function getJob(id: string): JobRecord | undefined {
  const row = getDb().prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listJobs(options: { status?: JobStatus; limit?: number } = {}): JobRecord[] {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const rows = options.status
    ? getDb().prepare("SELECT * FROM background_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(options.status, limit)
    : getDb().prepare("SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  return (rows as JobRow[]).map(rowToJob);
}

export function cancelJob(id: string): boolean {
  const result = getDb().prepare("UPDATE background_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'retrying', 'running')").run(new Date().toISOString(), id);
  return Number(result.changes) > 0;
}

export function recoverInterruptedJobs(): number {
  const result = getDb().prepare("UPDATE background_jobs SET status = 'retrying', updated_at = ?, error = 'Worker interrupted; queued for retry.' WHERE status = 'running'").run(new Date().toISOString());
  return Number(result.changes);
}

export function updateJobProgress(id: string, progress: number): boolean {
  const result = getDb().prepare("UPDATE background_jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(Math.min(100, Math.max(0, Math.round(progress))), new Date().toISOString(), id);
  return Number(result.changes) > 0;
}

export async function runNextJob(
  handler: (job: JobRecord, signal: AbortSignal) => Promise<void>,
  concurrency = 2,
): Promise<JobRecord | undefined> {
  if (activeWorkers >= Math.max(1, concurrency)) return undefined;
  const db = getDb();
  const queued = db.prepare("SELECT * FROM background_jobs WHERE status IN ('queued', 'retrying') ORDER BY created_at ASC LIMIT 1").get() as JobRow | undefined;
  if (!queued) return undefined;
  const claimed = db.prepare("UPDATE background_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'retrying')").run(new Date().toISOString(), queued.id);
  if (Number(claimed.changes) !== 1) return undefined;
  activeWorkers += 1;
  const job = getJob(queued.id)!;
  const controller = new AbortController();
  try {
    await handler(job, controller.signal);
    db.prepare("UPDATE background_jobs SET status = 'completed', progress = 100, updated_at = ?, error = NULL WHERE id = ? AND status = 'running'").run(new Date().toISOString(), job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = getJob(job.id);
    if (current?.status === "cancelled") return current;
    const nextStatus = current && current.attempts < current.maxAttempts ? "retrying" : "failed";
    db.prepare("UPDATE background_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(nextStatus, message, new Date().toISOString(), job.id);
  } finally {
    activeWorkers -= 1;
  }
  return getJob(job.id);
}
