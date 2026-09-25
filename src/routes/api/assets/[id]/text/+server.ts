import { error, json, type RequestHandler } from "@sveltejs/kit";
import { getAssetById, getAssetDiskLocation } from "$lib/server/assets";
import { readAssetBytes } from "$lib/server/asset-file-io";

const decoder = new TextDecoder();

export const GET: RequestHandler = async ({ params }) => {
  if (!params.id) {
    throw error(400, "Missing asset id");
  }

  const asset = await getAssetById(params.id);
  if (!asset) {
    throw error(404, "Asset not found");
  }

  if (asset.previewKind !== "text") {
    return json({ text: "" });
  }

  try {
    const location = await getAssetDiskLocation(asset.id);
    if (!location) throw new Error("missing location");
    const bytes = await readAssetBytes(location);
    const clipped = bytes.subarray(0, 32_000);
    return json({ text: decoder.decode(clipped) });
  } catch {
    throw error(404, "Asset file missing on disk");
  }
};
