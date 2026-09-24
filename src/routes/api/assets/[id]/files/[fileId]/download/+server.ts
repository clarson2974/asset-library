import { readFile } from "node:fs/promises";
import { error, type RequestHandler } from "@sveltejs/kit";
import { getAssetFileById, getStoredFilePath } from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    throw error(403, "Forbidden");
  }
  if (!params.id || !params.fileId) throw error(400, "Missing asset or file id");
  const file = await getAssetFileById(params.id, params.fileId);
  if (!file) throw error(404, "Asset file not found");

  try {
    const bytes = await readFile(getStoredFilePath(file.storedName));
    return new Response(bytes, {
      headers: {
        "content-type": file.mimeType,
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="${encodeURIComponent(file.originalName)}"`,
      },
    });
  } catch {
    throw error(404, "Asset file missing on disk");
  }
};