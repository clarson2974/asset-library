import { readFile } from "node:fs/promises";
import { error, json, type RequestHandler } from "@sveltejs/kit";
import {
  DuplicateAssetError,
  getAssetFileById,
  getStoredFilePath,
  replaceAssetChildFile,
  toAssetView,
  getAssetById,
} from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

async function resolveFile(assetId: string | undefined, fileId: string | undefined) {
  if (!assetId || !fileId) throw error(400, "Missing asset or file id");
  const file = await getAssetFileById(assetId, fileId);
  if (!file) throw error(404, "Asset file not found");
  return file;
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  const file = await resolveFile(params.id, params.fileId);
  try {
    const bytes = await readFile(getStoredFilePath(file.storedName));
    return new Response(bytes, {
      headers: {
        "content-type": file.mimeType,
        "content-length": String(file.size),
        "content-disposition": `inline; filename="${encodeURIComponent(file.originalName)}"`,
      },
    });
  } catch {
    throw error(404, "Asset file missing on disk");
  }
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }
  if (!params.id || !params.fileId) {
    return json({ error: "Missing asset or file id." }, { status: 400 });
  }
  const form = await request.formData();
  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) {
    return json({ error: "A replacement file is required." }, { status: 400 });
  }

  try {
    const file = await replaceAssetChildFile(params.id, params.fileId, {
      fileName: fileValue.name,
      mimeType: fileValue.type,
      size: fileValue.size,
      bytes: new Uint8Array(await fileValue.arrayBuffer()),
      role: typeof form.get("role") === "string" ? String(form.get("role")) as Parameters<typeof replaceAssetChildFile>[2]["role"] : undefined,
      variant: typeof form.get("variant") === "string" ? String(form.get("variant")) : undefined,
    });
    if (!file) return json({ error: "Asset file not found." }, { status: 404 });
    const asset = await getAssetById(params.id);
    return json({ file: toAssetView(asset!).files.find((entry) => entry.id === file.id) });
  } catch (errorValue) {
    if (errorValue instanceof DuplicateAssetError) {
      return json({ error: "This file already exists in the library.", duplicate: true, asset: toAssetView(errorValue.existingAsset) }, { status: 409 });
    }
    return json({ error: "Failed to replace file." }, { status: 500 });
  }
};