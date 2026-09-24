import { json, type RequestHandler } from "@sveltejs/kit";
import {
  cancelJob,
  getJob,
  listJobs,
  recoverInterruptedJobs,
  type JobStatus,
} from "$lib/server/jobs";
import { requireUserCapability } from "$lib/server/auth";

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  recoverInterruptedJobs();
  const id = url.searchParams.get("id");
  if (id) {
    const job = getJob(id);
    return job ? json({ job }) : json({ error: "Job not found." }, { status: 404 });
  }
  const status = url.searchParams.get("status") as JobStatus | null;
  return json({ jobs: listJobs({ status: status ?? undefined }) });
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const id = url.searchParams.get("id");
  if (!id || !cancelJob(id)) return json({ error: "Job not found or already finished." }, { status: 404 });
  return json({ ok: true });
};
