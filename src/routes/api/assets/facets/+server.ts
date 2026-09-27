import { json, type RequestHandler } from "@sveltejs/kit";
import { getAssetFacets } from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

export const GET: RequestHandler = async ({ locals }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  return json(await getAssetFacets());
};
