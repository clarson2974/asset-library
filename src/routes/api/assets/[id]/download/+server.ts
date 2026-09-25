import { error, type RequestHandler } from "@sveltejs/kit";
import { getAssetById, getAssetDiskLocation } from "$lib/server/assets";
import { readAssetBytes } from "$lib/server/asset-file-io";

export const GET: RequestHandler = async ({ params }) => {
  if (!params.id) {
    throw error(400, "Missing asset id");
  }

  const asset = await getAssetById(params.id);
  if (!asset) {
    throw error(404, "Asset not found");
  }

  try {
    const location = await getAssetDiskLocation(asset.id);
    if (!location) throw new Error("missing location");
    const bytes = await readAssetBytes(location);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": asset.mimeType,
        "content-length": String(asset.size),
        "content-disposition": `attachment; filename="${encodeURIComponent(asset.originalName)}"`,
      },
    });
  } catch {
    throw error(404, "Asset file missing on disk");
  }
};
