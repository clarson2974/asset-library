import { json, type RequestHandler } from "@sveltejs/kit";
import { getDatabaseHealth } from "$lib/server/assets";

export const GET: RequestHandler = async () => {
  const health = await getDatabaseHealth();

  if (!health.ok) {
    return json(
      {
        ok: false,
        path: health.path,
        error: health.error,
        kind: "database",
      },
      { status: 500 },
    );
  }

  return json({
    ok: true,
    path: health.path,
    kind: "database",
    migrationCount: health.migrationCount,
  });
};
