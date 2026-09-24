import { json, type RequestHandler } from "@sveltejs/kit";
import { getExternalLibraryImportStatus } from "$lib/server/external-library";
import { requireUserCapability } from "$lib/server/auth";

export const GET: RequestHandler = async ({ locals }) => {
  if (!(await requireUserCapability(locals.user, "settings.manage"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  return json({ status: getExternalLibraryImportStatus() });
};
