import { readFile } from "node:fs/promises";
import type { AssetDiskLocation } from "$lib/server/assets";
import { resolveExternalAssetReadPath } from "$lib/server/external-library";

// Shared by every file-serving route: resolves a managed or externally linked asset to readable bytes,
// re-validating external paths against the live library config on every read.
export async function readAssetBytes(location: AssetDiskLocation): Promise<Buffer> {
  const diskPath =
    location.mode === "external"
      ? await resolveExternalAssetReadPath(location.path)
      : location.path;
  return Buffer.from(await readFile(diskPath));
}
