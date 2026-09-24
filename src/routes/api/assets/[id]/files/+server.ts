import { json, type RequestHandler } from "@sveltejs/kit";
import {
  addAssetFile,
  DuplicateAssetError,
  getAssetById,
  toAssetView,
} from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

function parseRole(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : "other";
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  if (!params.id) {
    return json({ error: "Missing asset id." }, { status: 400 });
  }

  const asset = await getAssetById(params.id);
  if (!asset) {
    return json({ error: "Asset not found." }, { status: 404 });
  }

  return json({ files: toAssetView(asset).files });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.update"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  if (!params.id) {
    return json({ error: "Missing asset id." }, { status: 400 });
  }

  const form = await request.formData();
  const fileValue = form.get("file");
  if (!(fileValue instanceof File)) {
    return json({ error: "A file is required." }, { status: 400 });
  }

  try {
    const bytes = new Uint8Array(await fileValue.arrayBuffer());
    const file = await addAssetFile(params.id, {
      fileName: fileValue.name,
      mimeType: fileValue.type,
      size: fileValue.size,
      bytes,
      role: parseRole(form.get("role")) as Parameters<typeof addAssetFile>[1]["role"],
      variant: typeof form.get("variant") === "string" ? String(form.get("variant")) : "",
    });
    if (!file) {
      return json({ error: "Asset not found." }, { status: 404 });
    }

    const asset = await getAssetById(params.id);
    return json({ file: toAssetView(asset!).files.find((entry) => entry.id === file.id) }, { status: 201 });
  } catch (errorValue) {
    if (errorValue instanceof DuplicateAssetError) {
      return json(
        { error: "This file already exists in the library.", duplicate: true, asset: toAssetView(errorValue.existingAsset) },
        { status: 409 },
      );
    }
    return json({ error: "Failed to add file." }, { status: 500 });
  }
};