import { json, type RequestHandler } from "@sveltejs/kit";
import {
  getExternalLibraryConfig,
  getExternalLibraryScanState,
  importExternalLibraryEntries,
  scanExternalLibraries,
  updateExternalLibraryConfig,
  type ExternalLibraryConfig,
} from "$lib/server/external-library";
import { requireUserCapability } from "$lib/server/auth";

function configUpdates(body: Partial<ExternalLibraryConfig>): Partial<ExternalLibraryConfig> {
  return {
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    rootDirectory: typeof body.rootDirectory === "string" ? body.rootDirectory : undefined,
    roots: Array.isArray(body.roots)
      ? body.roots.filter((root): root is string => typeof root === "string")
      : undefined,
    ignorePatterns: Array.isArray(body.ignorePatterns)
      ? body.ignorePatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : undefined,
    supportedExtensions: Array.isArray(body.supportedExtensions)
      ? body.supportedExtensions.filter((extension): extension is string => typeof extension === "string")
      : undefined,
  };
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!(await requireUserCapability(locals.user, "settings.manage"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  const [config, state] = await Promise.all([
    getExternalLibraryConfig(),
    getExternalLibraryScanState(),
  ]);
  return json({ config, lastScan: state.lastScan ?? null });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "settings.manage"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json()) as Partial<ExternalLibraryConfig>;
  const config = await updateExternalLibraryConfig(configUpdates(body));
  return json({ config });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!(await requireUserCapability(locals.user, "settings.manage"))) {
    return json({ error: "Forbidden." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    paths?: unknown;
  };

  if (body.action === "import") {
    const paths = Array.isArray(body.paths)
      ? body.paths.filter((entry): entry is string => typeof entry === "string")
      : [];
    return json({ result: await importExternalLibraryEntries(paths) });
  }

  const scan = await scanExternalLibraries();
  return json({ scan });
};