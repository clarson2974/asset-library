import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataRoot = "";

async function loadAuthModule() {
  process.env.ASSET_LIBRARY_DATA_DIR = dataRoot;
  vi.resetModules();
  return import("$lib/server/auth");
}

async function createTempDataRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "asset-library-auth-test-"));
}

beforeEach(async () => {
  dataRoot = await createTempDataRoot();
});

afterEach(async () => {
  const { resetAuthStorageForTests } = await import("$lib/server/auth");
  resetAuthStorageForTests();
  delete process.env.ASSET_LIBRARY_DATA_DIR;
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("auth storage", () => {
  it("creates an admin user when the database is empty", async () => {
    const auth = await loadAuthModule();
    const user = await auth.ensureAdminUser();

    expect(user.email).toBe("admin@localhost");
    expect(user.status).toBe("active");
  });

  it("accepts valid credentials and returns a session cookie", async () => {
    const auth = await loadAuthModule();
    await auth.ensureAdminUser();

    const session = await auth.loginWithCredentials({
      email: "admin@localhost",
      password: "admin",
    });

    expect(session.user.email).toBe("admin@localhost");
    expect(session.cookie.name).toBe("asset_library_session");
    expect(session.cookie.value.length).toBeGreaterThan(20);
  });

  it("rejects invalid credentials without creating a session", async () => {
    const auth = await loadAuthModule();
    await auth.ensureAdminUser();

    await expect(
      auth.loginWithCredentials({
        email: "admin@localhost",
        password: "wrong-password",
      }),
    ).rejects.toThrow("Invalid email or password");
  });

  it("grants the default administrator role the required asset and settings capabilities", async () => {
    const auth = await loadAuthModule();
    const user = await auth.ensureAdminUser();

    expect(await auth.userHasCapability(user.id, "asset.read")).toBe(true);
    expect(await auth.userHasCapability(user.id, "asset.create")).toBe(true);
    expect(await auth.userHasCapability(user.id, "settings.manage")).toBe(true);
  });
});
