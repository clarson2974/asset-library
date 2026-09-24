import { json, type RequestHandler } from "@sveltejs/kit";
import {
  DuplicateAssetError,
  searchAssets,
  saveAsset,
  toAssetView,
} from "$lib/server/assets";
import { requireUserCapability } from "$lib/server/auth";

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!(await requireUserCapability(locals.user, "asset.read"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  const csv = (key: string) => url.searchParams.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  const sort = url.searchParams.get("sort");
  const validSort = ["best-match", "newest", "oldest", "title-asc", "size-desc", "needs-metadata"] as const;
  const result = await searchAssets({
    query: url.searchParams.get("q") ?? undefined,
    page: Number(url.searchParams.get("page") ?? 1),
    pageSize: Number(url.searchParams.get("pageSize") ?? 40),
    categories: csv("category"),
    tags: csv("tag"),
    licenses: csv("license"),
    todoOnly: url.searchParams.get("todo") === "1",
    includeDeleted: url.searchParams.get("includeDeleted") === "1",
    sort: validSort.includes(sort as (typeof validSort)[number]) ? sort as (typeof validSort)[number] : "best-match",
  });
  return json({
    assets: result.assets.map(toAssetView),
    pagination: { page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages },
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "asset.create"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  const form = await request.formData();
  const titleValue = form.get("title");
  const tagsValue = form.get("tags");
  const descriptionValue = form.get("description");
  const licensesValue = form.get("licenses");
  const sourceUrlValue = form.get("sourceUrl");
  const fileValue = form.get("file");

  if (typeof titleValue !== "string" || !titleValue.trim()) {
    return json({ error: "A title is required." }, { status: 400 });
  }

  if (!(fileValue instanceof File)) {
    return json({ error: "A file is required." }, { status: 400 });
  }

  const arrayBuffer = await fileValue.arrayBuffer();
  const tags = typeof tagsValue === "string" ? parseTags(tagsValue) : [];
  const description =
    typeof descriptionValue === "string" ? descriptionValue.trim() : "";
  const licenses =
    typeof licensesValue === "string" ? parseTags(licensesValue) : [];
  const sourceUrl =
    typeof sourceUrlValue === "string" ? sourceUrlValue.trim() : "";

  let record;
  try {
    record = await saveAsset({
      title: titleValue.trim(),
      description,
      tags,
      licenses,
      sourceUrl,
      fileName: fileValue.name,
      mimeType: fileValue.type,
      size: fileValue.size,
      bytes: new Uint8Array(arrayBuffer),
    });
  } catch (error) {
    if (error instanceof DuplicateAssetError) {
      return json(
        {
          error: `Duplicate upload skipped. Matching asset already exists: "${error.existingAsset.title}".`,
          duplicate: true,
          asset: toAssetView(error.existingAsset),
        },
        { status: 409 },
      );
    }

    console.error("Error saving asset:", error);
    return json({ error: "Failed to save asset." }, { status: 500 });
  }

  return json({ asset: toAssetView(record) }, { status: 201 });
};
