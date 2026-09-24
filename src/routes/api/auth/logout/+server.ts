import { json, type RequestHandler } from "@sveltejs/kit";
import { destroySession } from "$lib/server/auth";

export const POST: RequestHandler = async ({ cookies }) => {
  destroySession(cookies);
  return json({ ok: true });
};
