import { redirect, type Handle } from "@sveltejs/kit";
import { getSessionFromCookies } from "$lib/server/auth";

const PUBLIC_PATHS = [
  "/login",
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
];

const isPublicPath = (pathname: string): boolean => {
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }

  return pathname.startsWith("/_app/") || pathname.startsWith("/favicon") || pathname.startsWith("/robots.txt");
};

export const handle: Handle = async ({ event, resolve }) => {
  const pathname = new URL(event.request.url).pathname;

  if (isPublicPath(pathname)) {
    return resolve(event);
  }

  const user = getSessionFromCookies(event.cookies);
  if (!user) {
    if (pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Unauthorized." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }

    throw redirect(303, `/login?redirect=${encodeURIComponent(pathname + new URL(event.request.url).search)}`);
  }

  event.locals.user = user;
  return resolve(event);
};
