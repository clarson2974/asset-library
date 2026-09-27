import { readFile } from "node:fs/promises";
import { readFileHead, type AssetDiskLocation } from "$lib/server/assets";
import { resolveExternalAssetReadPath } from "$lib/server/external-library";

// Shared by every file-serving route: resolves a managed or externally linked asset to a readable path,
// re-validating external paths against the live library config on every read.
export async function resolveAssetReadPath(location: AssetDiskLocation): Promise<string> {
  return location.mode === "external"
    ? await resolveExternalAssetReadPath(location.path)
    : location.path;
}

export async function readAssetBytes(location: AssetDiskLocation): Promise<Buffer> {
  return Buffer.from(await readFile(await resolveAssetReadPath(location)));
}

export async function readAssetHead(location: AssetDiskLocation, maxBytes: number): Promise<Uint8Array> {
  return readFileHead(await resolveAssetReadPath(location), maxBytes);
}
