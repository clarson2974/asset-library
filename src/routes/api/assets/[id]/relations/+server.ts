import { json, type RequestHandler } from "@sveltejs/kit";
import {
  addAssetRelation,
  getAssetById,
  listAssetRelations,
} from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

const relationTypes = ["contains", "variant", "derived-from"] as const;

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  if (!params.id) return json({ error: "Missing asset id." }, { status: 400 });
  return json({ relations: await listAssetRelations(params.id) });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  if (!params.id) return json({ error: "Missing asset id." }, { status: 400 });

  const body = (await request.json()) as {
    childAssetId?: unknown;
    relationType?: unknown;
  };
  if (
    typeof body.childAssetId !== "string" ||
    !relationTypes.includes(body.relationType as (typeof relationTypes)[number])
  ) {
    return json({ error: "A childAssetId and valid relationType are required." }, { status: 400 });
  }
  if (!(await getAssetById(params.id)) || !(await getAssetById(body.childAssetId))) {
    return json({ error: "Asset not found." }, { status: 404 });
  }

  const created = await addAssetRelation(
    params.id,
    body.childAssetId,
    body.relationType as (typeof relationTypes)[number],
  );
  return json({ ok: created }, { status: created ? 201 : 400 });
};