import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createHash, pbkdf2Sync } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt?: string;
};

export type LoginResult = {
  user: AuthUser;
  sessionToken: string;
  cookie: {
    name: string;
    value: string;
    maxAge: number;
    httpOnly: boolean;
    sameSite: "lax" | "strict";
    secure: boolean;
    path: string;
  };
};

const SESSION_COOKIE_NAME = "asset_library_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_ADMIN_EMAIL = "admin@localhost";
const DEFAULT_ADMIN_PASSWORD = "admin";

const dataRoot = path.resolve(
  process.env.ASSET_LIBRARY_DATA_DIR?.trim() || path.join(process.cwd(), "data"),
);
const dbPath = path.join(dataRoot, "assets.db");

let db: DatabaseSync | undefined;

export function resetAuthStorageForTests(): void {
  db?.close();
  db = undefined;
}

function getDataDb(): DatabaseSync {
  if (db) {
    return db;
  }

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureAuthTables(db);
  return db;
}

function ensureAuthTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      email_normalized TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent_summary TEXT,
      ip_summary TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const migrationRow = database
    .prepare("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
    .get("002_auth_tables") as { 1: number } | undefined;

  if (!migrationRow) {
    database
      .prepare(
        "INSERT INTO schema_migrations (id, description, applied_at) VALUES (@id, @description, @applied_at)",
      )
      .run({
        id: "002_auth_tables",
        description: "Create user and session tables for login and session management.",
        applied_at: new Date().toISOString(),
      });
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120_000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, passwordHash: string): boolean {
  const [salt, expectedHash] = passwordHash.split(":", 2);
  if (!salt || !expectedHash) {
    return false;
  }

  const derived = pbkdf2Sync(password, salt, 120_000, 64, "sha512");
  const actualHash = derived.toString("hex");
  return timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rowToUser(row: {
  id: string;
  email: string;
  display_name: string;
  status: string;
  created_at: string;
  last_login_at?: string | null;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status === "disabled" ? "disabled" : "active",
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export async function ensureAdminUser(): Promise<AuthUser> {
  const database = getDataDb();
  const row = database
    .prepare("SELECT id, email, display_name, status, created_at, last_login_at FROM users LIMIT 1")
    .get() as
    | {
        id: string;
        email: string;
        display_name: string;
        status: string;
        created_at: string;
        last_login_at?: string | null;
      }
    | undefined;

  if (row) {
    return rowToUser(row);
  }

  const email = normalizeEmail(
    process.env.ADMIN_EMAIL?.trim() || DEFAULT_ADMIN_EMAIL,
  );
  const password = process.env.ADMIN_PASSWORD?.trim() || DEFAULT_ADMIN_PASSWORD;
  const now = new Date().toISOString();
  const id = randomUUID();

  database
    .prepare(
      `
        INSERT INTO users (
          id,
          email,
          email_normalized,
          display_name,
          password_hash,
          status,
          created_at,
          updated_at,
          last_login_at
        ) VALUES (
          @id,
          @email,
          @email_normalized,
          @display_name,
          @password_hash,
          @status,
          @created_at,
          @updated_at,
          @last_login_at
        )
      `,
    )
    .run({
      id,
      email,
      email_normalized: email,
      display_name: "Administrator",
      password_hash: hashPassword(password),
      status: "active",
      created_at: now,
      updated_at: now,
      last_login_at: null,
    });

  return {
    id,
    email,
    displayName: "Administrator",
    status: "active",
    createdAt: now,
  };
}

export async function loginWithCredentials(params: {
  email: string;
  password: string;
}): Promise<LoginResult> {
  const database = getDataDb();
  const normalizedEmail = normalizeEmail(params.email);
  const userRow = database
    .prepare(
      `
        SELECT
          id,
          email,
          display_name,
          status,
          created_at,
          last_login_at,
          password_hash
        FROM users
        WHERE email_normalized = ?
        LIMIT 1
      `,
    )
    .get(normalizedEmail) as
    | {
        id: string;
        email: string;
        display_name: string;
        status: string;
        created_at: string;
        last_login_at?: string | null;
        password_hash: string;
      }
    | undefined;

  if (!userRow || userRow.status !== "active") {
    throw new Error("Invalid email or password");
  }

  if (!verifyPassword(params.password, userRow.password_hash)) {
    throw new Error("Invalid email or password");
  }

  const sessionToken = randomBytes(32).toString("hex");
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  database
    .prepare(
      `
        INSERT INTO sessions (
          id,
          user_id,
          token_hash,
          created_at,
          expires_at,
          last_seen_at,
          revoked_at,
          user_agent_summary,
          ip_summary
        ) VALUES (
          @id,
          @user_id,
          @token_hash,
          @created_at,
          @expires_at,
          @last_seen_at,
          @revoked_at,
          @user_agent_summary,
          @ip_summary
        )
      `,
    )
    .run({
      id: sessionId,
      user_id: userRow.id,
      token_hash: hashToken(sessionToken),
      created_at: now,
      expires_at: expiresAt,
      last_seen_at: now,
      revoked_at: null,
      user_agent_summary: null,
      ip_summary: null,
    });

  database
    .prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, userRow.id);

  return {
    user: rowToUser(userRow),
    sessionToken,
    cookie: {
      name: SESSION_COOKIE_NAME,
      value: sessionToken,
      maxAge: Math.round(SESSION_TTL_MS / 1000),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  };
}

export function getSessionFromCookies(cookies: {
  get(name: string): string | undefined;
}): AuthUser | undefined {
  const token = cookies.get(SESSION_COOKIE_NAME);
  if (!token) {
    return undefined;
  }

  const database = getDataDb();
  const sessionRow = database
    .prepare(
      `
        SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_seen_at
        FROM sessions s
        WHERE s.token_hash = ?
        LIMIT 1
      `,
    )
    .get(hashToken(token)) as
    | {
        id: string;
        user_id: string;
        expires_at: string;
        revoked_at: string | null;
        last_seen_at: string;
      }
    | undefined;

  if (!sessionRow) {
    return undefined;
  }

  if (sessionRow.revoked_at || new Date(sessionRow.expires_at).getTime() <= Date.now()) {
    return undefined;
  }

  const userRow = database
    .prepare(
      `
        SELECT id, email, display_name, status, created_at, last_login_at
        FROM users
        WHERE id = ? AND status = 'active'
        LIMIT 1
      `,
    )
    .get(sessionRow.user_id) as
    | {
        id: string;
        email: string;
        display_name: string;
        status: string;
        created_at: string;
        last_login_at?: string | null;
      }
    | undefined;

  if (!userRow) {
    return undefined;
  }

  database
    .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
    .run(new Date().toISOString(), sessionRow.id);

  return rowToUser(userRow);
}

export function destroySession(cookies: { delete(name: string, options?: { path?: string }): void }): void {
  cookies.delete(SESSION_COOKIE_NAME, { path: "/" });
}

export function ensureAuthBootstrap(): void {
  ensureAdminUser();
}
