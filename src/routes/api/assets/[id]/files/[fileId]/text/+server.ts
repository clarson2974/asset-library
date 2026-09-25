import { error, json, type RequestHandler } from "@sveltejs/kit";
import { getAssetFileById, getAssetFileDiskLocationById } from "$lib/server/assets";
import { readAssetBytes } from "$lib/server/asset-file-io";
import { requireUserCapability } from "$lib/server/auth";

const decoder = new TextDecoder();

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  if (!params.id || !params.fileId) throw error(400, "Missing asset or file id");
  const file = await getAssetFileById(params.id, params.fileId);
  if (!file) throw error(404, "Asset file not found");
  if (file.previewKind !== "text") return json({ text: "" });

  try {
    const location = await getAssetFileDiskLocationById(file.id);
    if (!location) throw new Error("missing location");
    const bytes = await readAssetBytes(location);
    return json({ text: decoder.decode(bytes.subarray(0, 32_000)) });
  } catch {
    throw error(404, "Asset file missing on disk");
  }
};