import { json, type RequestHandler } from "@sveltejs/kit";
import {
  getAssetById,
  setAssetDeleted,
  updateAssetMetadata,
} from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

export const PATCH: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const body = (await request.json()) as { ids?: unknown; tags?: unknown; licenses?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean) : [];
  const licenses = Array.isArray(body.licenses) ? body.licenses.filter((license): license is string => typeof license === "string").map((license) => license.trim()).filter(Boolean) : [];
  if (ids.length === 0 || (tags.length === 0 && licenses.length === 0)) {
    return json({ error: "Asset ids and tags or licenses are required." }, { status: 400 });
  }
  let updated = 0;
  for (const id of ids) {
    const asset = await getAssetById(id);
    if (!asset) continue;
    const result = await updateAssetMetadata(id, {
      title: asset.title,
      description: asset.description,
      tags: tags.length > 0 ? [...new Set([...asset.tags, ...tags])] : asset.tags,
      licenses: licenses.length > 0 ? [...new Set([...asset.licenses, ...licenses])] : asset.licenses,
      sourceUrl: asset.sourceUrl,
    });
    if (result) updated += 1;
  }
  return json({ updated });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.delete"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const body = (await request.json()) as { ids?: unknown; deleted?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  if (ids.length === 0 || typeof body.deleted !== "boolean") {
    return json({ error: "Asset ids and deleted state are required." }, { status: 400 });
  }
  let updated = 0;
  for (const id of ids) if (await setAssetDeleted(id, body.deleted)) updated += 1;
  return json({ updated });
};
