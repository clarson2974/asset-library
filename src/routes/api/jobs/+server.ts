import { json, type RequestHandler } from "@sveltejs/kit";
import {
  cancelJob,
  enqueueJob,
  getJob,
  listJobs,
  type JobRecord,
  type JobStatus,
  type JobType,
} from "$lib/server/jobs";
import { RUNNABLE_JOB_TYPES, wakeJobWorker } from "$lib/server/job-worker";
import { getAssetById } from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

const MAX_ASSETS_PER_REQUEST = 500;

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const id = url.searchParams.get("id");
  if (id) {
    const job = getJob(id);
    return job ? json({ job }) : json({ error: "Job not found." }, { status: 404 });
  }
  const status = url.searchParams.get("status") as JobStatus | null;
  return json({ jobs: listJobs({ status: status ?? undefined }) });
};

// Queues one job per asset: { type: "hash" | "metadata" | "ai-tagging", assetIds: string[] }.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  let body: { type?: unknown; assetIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const type = body.type as JobType;
  if (!RUNNABLE_JOB_TYPES.includes(type)) {
    return json({ error: `Job type must be one of: ${RUNNABLE_JOB_TYPES.join(", ")}.` }, { status: 400 });
  }
  const assetIds = Array.isArray(body.assetIds)
    ? [...new Set(body.assetIds.filter((value): value is string => typeof value === "string" && value.trim() !== ""))]
    : [];
  if (assetIds.length === 0) {
    return json({ error: "At least one asset id is required." }, { status: 400 });
  }
  if (assetIds.length > MAX_ASSETS_PER_REQUEST) {
    return json({ error: `At most ${MAX_ASSETS_PER_REQUEST} assets per request.` }, { status: 400 });
  }

  const missing: string[] = [];
  for (const assetId of assetIds) {
    if (!(await getAssetById(assetId))) missing.push(assetId);
  }
  if (missing.length > 0) {
    return json({ error: "Some assets were not found.", missing }, { status: 404 });
  }

  const jobs: JobRecord[] = assetIds.map((assetId) => enqueueJob({ type, assetId }));
  wakeJobWorker();
  return json({ jobs }, { status: 202 });
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const id = url.searchParams.get("id");
  if (!id || !cancelJob(id)) return json({ error: "Job not found or already finished." }, { status: 404 });
  return json({ ok: true });
};
