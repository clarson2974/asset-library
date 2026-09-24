import { json, type RequestHandler } from "@sveltejs/kit";
import { loginWithCredentials } from "$lib/server/auth";

export const POST: RequestHandler = async ({ request, cookies }) => {
  const body = (await request.json()) as { email?: unknown; password?: unknown };

  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return json({ error: "Invalid email or password." }, { status: 400 });
  }

  try {
    const result = await loginWithCredentials({
      email: body.email,
      password: body.password,
    });

    cookies.set(result.cookie.name, result.cookie.value, {
      path: result.cookie.path,
      maxAge: result.cookie.maxAge,
      httpOnly: result.cookie.httpOnly,
      sameSite: result.cookie.sameSite,
      secure: result.cookie.secure,
    });

    return json({ user: result.user });
  } catch {
    return json({ error: "Invalid email or password." }, { status: 401 });
  }
};
