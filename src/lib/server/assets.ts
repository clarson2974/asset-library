import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";
import type {
  AssetCategory,
  AssetFileMetadataKind,
  AssetFileRecord,
  AssetFileRole,
  AssetPreviewKind,
  AssetRelation,
  AssetRecord,
  AssetView,
} from "$lib/types";
import { generateAutoMetadata } from "$lib/server/ai";

const dataRoot = path.resolve(
  process.env.ASSET_LIBRARY_DATA_DIR?.trim() || path.join(process.cwd(), "data"),
);
const uploadsDir = path.join(dataRoot, "uploads");
const dbPath = path.join(dataRoot, "assets.db");
const metadataPath = path.join(dataRoot, "assets.json");

const modelExtensions = new Set([
  ".glb",
  ".gltf",
  ".obj",
  ".fbx",
  ".stl",
  ".blend",
]);
const textureExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tga",
  ".ktx2",
]);
const audioExtensions = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
]);
const shaderExtensions = new Set([
  ".glsl",
  ".vert",
  ".frag",
  ".wgsl",
  ".hlsl",
  ".shader",
]);
const scriptExtensions = new Set([
  ".js",
  ".ts",
  ".py",
  ".lua",
  ".json",
  ".cs",
  ".cpp",
  ".h",
]);
const textDecoder = new TextDecoder();

const DEFAULT_LICENSE = "Unknown";
const MIGRATION_BACKUP_LIMIT = 5;

type AssetRow = {
  id: string;
  title: string;
  description: string;
  tags_json: string;
  licenses_json: string;
  source_url: string;
  metadata_edited: number;
  upload_date: string;
  original_name: string;
  stored_name: string;
  file_type: string;
  hash: string | null;
  mime_type: string;
  size: number;
  category: string;
  preview_kind: string;
  width: number | null;
  height: number | null;
  deleted_at?: string | null;
};

export type AssetSearchOptions = {
  query?: string;
  page?: number;
  pageSize?: number;
  categories?: string[];
  tags?: string[];
  licenses?: string[];
  todoOnly?: boolean;
  sort?: "best-match" | "newest" | "oldest" | "title-asc" | "size-desc" | "needs-metadata";
  includeDeleted?: boolean;
};

export type AssetSearchResult = {
  assets: AssetRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type AssetFileRow = {
  id: string;
  asset_id: string;
  role: string;
  variant: string;
  original_name: string;
  stored_name: string;
  file_type: string;
  hash: string | null;
  mime_type: string;
  size: number;
  category: string;
  preview_kind: string;
  width: number | null;
  height: number | null;
  metadata_json: string;
  created_at: string;
};

type DatabaseHealth =
  | {
      ok: true;
      path: string;
      migrationCount: number;
    }
  | {
      ok: false;
      path: string;
      error: string;
    };

type MigrationDefinition = {
  id: string;
  description: string;
  run: (database: DatabaseSync) => void;
};

const migrations: MigrationDefinition[] = [
  {
    id: "001_initial_assets_schema",
    description: "Create the base asset schema and index set.",
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          licenses_json TEXT NOT NULL,
          source_url TEXT NOT NULL,
          metadata_edited INTEGER NOT NULL,
          upload_date TEXT NOT NULL,
          original_name TEXT NOT NULL,
          stored_name TEXT NOT NULL,
          file_type TEXT NOT NULL,
          hash TEXT,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          category TEXT NOT NULL,
          preview_kind TEXT NOT NULL,
          width INTEGER,
          height INTEGER
        );
      `);
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_assets_upload_date ON assets(upload_date DESC)",
      );
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_hash ON assets(hash)");
    },
  },
  {
    id: "003_logical_assets_and_files",
    description: "Create logical asset files and migrate each legacy file into a child record.",
    run(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS asset_files (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'source',
          variant TEXT NOT NULL DEFAULT '',
          original_name TEXT NOT NULL,
          stored_name TEXT NOT NULL UNIQUE,
          file_type TEXT NOT NULL,
          hash TEXT,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          category TEXT NOT NULL,
          preview_kind TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );
      `);
      database.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_files_hash ON asset_files(hash) WHERE hash IS NOT NULL",
      );
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_asset_files_asset_id ON asset_files(asset_id)",
      );
      database.exec(`
        CREATE TABLE IF NOT EXISTS asset_relations (
          parent_asset_id TEXT NOT NULL,
          child_asset_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          PRIMARY KEY (parent_asset_id, child_asset_id, relation_type),
          FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
          FOREIGN KEY (child_asset_id) REFERENCES assets(id) ON DELETE CASCADE
        );
      `);
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_asset_relations_child ON asset_relations(child_asset_id)",
      );

      const legacyRows = database
        .prepare(
          `
            SELECT id, original_name, stored_name, file_type, hash, mime_type,
              size, category, preview_kind, width, height, upload_date
            FROM assets
            WHERE NOT EXISTS (
              SELECT 1 FROM asset_files WHERE asset_files.asset_id = assets.id
            )
          `,
        )
        .all() as Array<AssetRow>;
      const insertFile = database.prepare(`
        INSERT INTO asset_files (
          id, asset_id, role, variant, original_name, stored_name, file_type,
          hash, mime_type, size, category, preview_kind, width, height,
          metadata_json, created_at
        ) VALUES (?, ?, 'source', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
      `);
      for (const row of legacyRows) {
        insertFile.run(
          `${row.id}:primary`,
          row.id,
          row.original_name,
          row.stored_name,
          row.file_type,
          row.hash,
          row.mime_type,
          row.size,
          row.category,
          row.preview_kind,
          row.width,
          row.height,
          row.upload_date,
        );
      }
    },
  },
  {
    id: "004_search_jobs_and_soft_delete",
    description: "Add catalog search indexing and reversible soft deletion.",
    run(database) {
      const columns = database.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "deleted_at")) {
        database.exec("ALTER TABLE assets ADD COLUMN deleted_at TEXT");
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_assets_deleted_upload ON assets(deleted_at, upload_date DESC)");
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS assets_search USING fts5(
          asset_id UNINDEXED,
          title,
          description,
          tags,
          licenses,
          original_name,
          category,
          file_type
        );
      `);
      database.exec("DELETE FROM assets_search");
      const rows = database.prepare("SELECT id, title, description, tags_json, licenses_json, original_name, category, file_type FROM assets").all() as Array<Record<string, string>>;
      const insert = database.prepare("INSERT INTO assets_search (asset_id, title, description, tags, licenses, original_name, category, file_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of rows) {
        insert.run(row.id, row.title, row.description, row.tags_json, row.licenses_json, row.original_name, row.category, row.file_type);
      }
    },
  },
];
const knownExternalMigrationIds = new Set(["002_auth_tables"]);

let db: DatabaseSync | undefined;
let storageReady: Promise<void> | undefined;

export function resetStorageForTests(): void {
  db?.close();
  db = undefined;
  storageReady = undefined;
}

export class DuplicateAssetError extends Error {
  existingAsset: AssetRecord;

  constructor(existingAsset: AssetRecord) {
    super("Duplicate asset detected.");
    this.name = "DuplicateAssetError";
    this.existingAsset = existingAsset;
  }
}

function computeAssetHash(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function backupDatabaseBeforeMigration(): void {
  if (!existsSync(dbPath)) {
    return;
  }

  const backupDir = path.join(dataRoot, ".backups");
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `assets.db.${timestamp}.bak`);
  copyFileSync(dbPath, backupPath);

  const backups = readdirSync(backupDir)
    .filter((name) => /^assets\.db\..+\.bak$/.test(name))
    .sort();

  const excessBackups = backups.slice(0, Math.max(0, backups.length - MIGRATION_BACKUP_LIMIT));
  for (const staleName of excessBackups) {
    rmSync(path.join(backupDir, staleName), { force: true });
  }
}

function ensureSchemaMigrationsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function applyMigrations(database: DatabaseSync): void {
  ensureSchemaMigrationsTable(database);
  const appliedMigrationIds = new Set(
    (database
      .prepare("SELECT id FROM schema_migrations")
      .all() as Array<{ id: string }>).map((row) => row.id),
  );
  const unknownAppliedMigrations = [...appliedMigrationIds].filter(
    (migrationId) =>
      !migrations.some((migration) => migration.id === migrationId) &&
      !knownExternalMigrationIds.has(migrationId),
  );

  if (unknownAppliedMigrations.length > 0) {
    throw new Error(
      "Database schema is newer than this application supports. Unsafe downgrade refused.",
    );
  }

  const pendingMigrations = migrations.filter(
    (migration) => !appliedMigrationIds.has(migration.id),
  );

  if (pendingMigrations.length === 0) {
    return;
  }

  backupDatabaseBeforeMigration();

  for (const migration of pendingMigrations) {
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.run(database);
      database
        .prepare(
          `
            INSERT INTO schema_migrations (id, description, applied_at)
            VALUES (@id, @description, @applied_at)
          `,
        )
        .run({
          id: migration.id,
          description: migration.description,
          applied_at: new Date().toISOString(),
        });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function ensureAssetHashes(): Promise<void> {
  const database = getDb();
  const rows = database
    .prepare(
      "SELECT id, stored_name FROM assets WHERE hash IS NULL OR TRIM(hash) = ''",
    )
    .all() as Array<{ id: string; stored_name: string }>;

  if (rows.length === 0) {
    return;
  }

  const updateHash = database.prepare(
    "UPDATE assets SET hash = ? WHERE id = ?",
  );
  for (const row of rows) {
    try {
      const fileBytes = await readFile(path.join(uploadsDir, row.stored_name));
      updateHash.run(computeAssetHash(fileBytes), row.id);
    } catch {
      // Ignore missing files and keep legacy records untouched.
    }
  }
}

function getDb(): DatabaseSync {
  if (db) {
    return db;
  }

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(db);

  return db;
}

export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  try {
    await ensureStorage();
    const database = getDb();
    const migrationCountResult = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number } | undefined;

    return {
      ok: true,
      path: dbPath,
      migrationCount: Number(migrationCountResult?.count ?? 0),
    };
  } catch (error) {
    return {
      ok: false,
      path: dbPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseStringArray(value: string, fallback: string[] = []): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return fallback;
  }
}

function normalizeImportedRecord(record: AssetRecord): AssetRecord {
  const normalizedLicenses = Array.isArray(record.licenses)
    ? record.licenses.map((license) => license.trim()).filter(Boolean)
    : [];

  return {
    ...record,
    fileType:
      typeof record.fileType === "string" && record.fileType.trim()
        ? record.fileType.trim().toLowerCase()
        : getFileType(record.originalName, record.mimeType),
    hash:
      typeof record.hash === "string" && record.hash.trim()
        ? record.hash.trim()
        : undefined,
    description:
      typeof record.description === "string" ? record.description.trim() : "",
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : "",
    licenses:
      normalizedLicenses.length > 0 ? normalizedLicenses : [DEFAULT_LICENSE],
    metadataEdited: record.metadataEdited ?? true,
    previewKind: getPreviewKind(
      record.category,
      record.originalName,
      record.mimeType,
    ),
  };
}

function rowToAssetRecord(row: AssetRow): AssetRecord {
  const category = (row.category || "other") as AssetCategory;
  const fallbackPreviewKind = getPreviewKind(
    category,
    row.original_name,
    row.mime_type,
  );

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: parseStringArray(row.tags_json),
    licenses: (() => {
      const parsed = parseStringArray(row.licenses_json);
      return parsed.length > 0 ? parsed : [DEFAULT_LICENSE];
    })(),
    sourceUrl: row.source_url,
    metadataEdited: Boolean(row.metadata_edited),
    uploadDate: row.upload_date,
    originalName: row.original_name,
    storedName: row.stored_name,
    fileType:
      typeof row.file_type === "string" && row.file_type.trim()
        ? row.file_type.trim().toLowerCase()
        : getFileType(row.original_name, row.mime_type),
    hash: row.hash?.trim() || undefined,
    mimeType: row.mime_type,
    size: Number(row.size),
    category,
    previewKind:
      row.preview_kind === "audio" ||
      row.preview_kind === "image" ||
      row.preview_kind === "model" ||
      row.preview_kind === "text" ||
      row.preview_kind === "none"
        ? row.preview_kind
        : fallbackPreviewKind,
    width: typeof row.width === "number" ? row.width : undefined,
    height: typeof row.height === "number" ? row.height : undefined,
    files: [],
  };
}

function normalizeFileRole(value: string): AssetFileRole {
  const roles: AssetFileRole[] = [
    "source",
    "model",
    "texture",
    "animation",
    "audio",
    "preview",
    "document",
    "other",
  ];
  return roles.includes(value as AssetFileRole)
    ? (value as AssetFileRole)
    : "other";
}

function rowToAssetFile(row: AssetFileRow): AssetFileRecord {
  let metadata: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = undefined;
  }

  return {
    id: row.id,
    assetId: row.asset_id,
    role: normalizeFileRole(row.role),
    variant: row.variant,
    originalName: row.original_name,
    storedName: row.stored_name,
    fileType: row.file_type,
    hash: row.hash?.trim() || undefined,
    mimeType: row.mime_type,
    size: Number(row.size),
    category: (row.category || "other") as AssetCategory,
    previewKind: ["audio", "image", "model", "text", "none"].includes(
      row.preview_kind,
    )
      ? (row.preview_kind as AssetPreviewKind)
      : "none",
    width: typeof row.width === "number" ? row.width : undefined,
    height: typeof row.height === "number" ? row.height : undefined,
    metadata,
    createdAt: row.created_at,
  };
}

function getAssetFiles(database: DatabaseSync, assetId: string): AssetFileRecord[] {
  const rows = database
    .prepare(
      `
        SELECT id, asset_id, role, variant, original_name, stored_name, file_type,
          hash, mime_type, size, category, preview_kind, width, height,
          metadata_json, created_at
        FROM asset_files
        WHERE asset_id = ?
        ORDER BY created_at ASC, id ASC
      `,
    )
    .all(assetId) as AssetFileRow[];
  return rows.map(rowToAssetFile);
}

function hydrateAsset(database: DatabaseSync, record: AssetRecord): AssetRecord {
  return { ...record, files: getAssetFiles(database, record.id) };
}

function indexAsset(database: DatabaseSync, record: AssetRecord): void {
  database.prepare("DELETE FROM assets_search WHERE asset_id = ?").run(record.id);
  database.prepare(
    "INSERT INTO assets_search (asset_id, title, description, tags, licenses, original_name, category, file_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    record.id,
    record.title,
    record.description,
    record.tags.join(" "),
    record.licenses.join(" "),
    record.originalName,
    record.category,
    record.fileType,
  );
}

function insertRecord(database: DatabaseSync, record: AssetRecord): void {
  database
    .prepare(
      `
        INSERT INTO assets (
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        ) VALUES (
          @id,
          @title,
          @description,
          @tags_json,
          @licenses_json,
          @source_url,
          @metadata_edited,
          @upload_date,
          @original_name,
          @stored_name,
          @file_type,
          @hash,
          @mime_type,
          @size,
          @category,
          @preview_kind,
          @width,
          @height
        )
      `,
    )
    .run({
      id: record.id,
      title: record.title,
      description: record.description,
      tags_json: JSON.stringify(record.tags),
      licenses_json: JSON.stringify(record.licenses),
      source_url: record.sourceUrl,
      metadata_edited: record.metadataEdited ? 1 : 0,
      upload_date: record.uploadDate,
      original_name: record.originalName,
      stored_name: record.storedName,
      file_type: record.fileType,
      hash: record.hash ?? null,
      mime_type: record.mimeType,
      size: record.size,
      category: record.category,
      preview_kind: record.previewKind,
      width: record.width ?? null,
      height: record.height ?? null,
    });
}

function insertAssetFile(
  database: DatabaseSync,
  file: AssetFileRecord,
): void {
  database
    .prepare(
      `
        INSERT INTO asset_files (
          id, asset_id, role, variant, original_name, stored_name, file_type,
          hash, mime_type, size, category, preview_kind, width, height,
          metadata_json, created_at
        ) VALUES (
          @id, @asset_id, @role, @variant, @original_name, @stored_name,
          @file_type, @hash, @mime_type, @size, @category, @preview_kind,
          @width, @height, @metadata_json, @created_at
        )
      `,
    )
    .run({
      id: file.id,
      asset_id: file.assetId,
      role: file.role,
      variant: file.variant,
      original_name: file.originalName,
      stored_name: file.storedName,
      file_type: file.fileType,
      hash: file.hash ?? null,
      mime_type: file.mimeType,
      size: file.size,
      category: file.category,
      preview_kind: file.previewKind,
      width: file.width ?? null,
      height: file.height ?? null,
      metadata_json: JSON.stringify(file.metadata ?? {}),
      created_at: file.createdAt,
    });
}

async function migrateLegacyJsonIfNeeded(
  database: DatabaseSync,
): Promise<void> {
  const countResult = database
    .prepare("SELECT COUNT(*) AS count FROM assets")
    .get() as { count: number };
  if (Number(countResult.count) > 0) {
    return;
  }

  let raw: string;
  try {
    raw = await readFile(metadataPath, "utf8");
  } catch {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return;
  }

  const records = parsed
    .filter((entry): entry is AssetRecord => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as AssetRecord).id === "string" &&
        typeof (entry as AssetRecord).storedName === "string"
      );
    })
    .map((entry) => normalizeImportedRecord(entry));

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const record of records) {
      try {
        insertRecord(database, record);
        insertAssetFile(database, {
          id: `${record.id}:primary`,
          assetId: record.id,
          role: "source",
          variant: "",
          originalName: record.originalName,
          storedName: record.storedName,
          fileType: record.fileType,
          hash: record.hash,
          mimeType: record.mimeType,
          size: record.size,
          category: record.category,
          previewKind: record.previewKind,
          width: record.width,
          height: record.height,
          createdAt: record.uploadDate,
        });
      } catch {
        // Skip malformed or duplicate legacy entries during migration.
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function ensureStorage(): Promise<void> {
  if (!storageReady) {
    storageReady = (async () => {
      await mkdir(dataRoot, { recursive: true });
      await mkdir(uploadsDir, { recursive: true });
      const database = getDb();
      await migrateLegacyJsonIfNeeded(database);
    })();
  }

  try {
    await storageReady;
  } catch (error) {
    storageReady = undefined;
    throw error;
  }
}

function getCategory(fileName: string, mimeType: string): AssetCategory {
  const ext = path.extname(fileName).toLowerCase();
  if (mimeType.startsWith("audio/") || audioExtensions.has(ext)) return "audio";
  if (mimeType.startsWith("image/") || textureExtensions.has(ext))
    return "texture";
  if (modelExtensions.has(ext)) return "model";
  if (shaderExtensions.has(ext)) return "shader";
  if (scriptExtensions.has(ext) || mimeType.startsWith("text/"))
    return "script";
  return "other";
}

function getPreviewKind(
  category: AssetCategory,
  fileName: string,
  mimeType: string,
): AssetPreviewKind {
  if (category === "audio") return "audio";
  if (category === "texture") return "image";
  if (category === "shader" || category === "script") return "text";

  if (category === "model") {
    const ext = path.extname(fileName).toLowerCase();
    if ([".glb", ".gltf", ".obj", ".stl", ".fbx"].includes(ext)) {
      return "model";
    }
    if (mimeType === "model/gltf-binary" || mimeType === "model/gltf+json") {
      return "model";
    }
  }

  return "none";
}

function getAudioAttachmentFormat(
  fileName: string,
  mimeType: string,
): "mp3" | "wav" | undefined {
  const ext = path.extname(fileName).toLowerCase();
  if (
    mimeType === "audio/wav" ||
    mimeType === "audio/x-wav" ||
    ext === ".wav"
  ) {
    return "wav";
  }
  if (mimeType === "audio/mpeg" || ext === ".mp3") {
    return "mp3";
  }
  return undefined;
}

export function detectPbrTextureSet(fileName: string): {
  kind: string;
  value: string;
} | null {
  const normalized = fileName.toLowerCase();
  const tokens = normalized
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const joined = tokens.join(" ");
  const patterns: Array<[string | RegExp, string]> = [
    [/basecolor|albedo|color|diffuse/, "baseColor"],
    [/normal|bump/, "normal"],
    [/orm|rma|occlusion.*roughness.*metallic|roughness.*metallic.*ao/, "orm"],
    [/roughness/, "roughness"],
    [/metallic/, "metallic"],
    [/ao|ambientocclusion/, "ao"],
    [/emissive|glow/, "emissive"],
    [/opacity|alpha/, "opacity"],
    [/height|displacement|bumpheight/, "height"],
  ];

  for (const [pattern, kind] of patterns) {
    if (pattern instanceof RegExp ? pattern.test(joined) : joined.includes(pattern)) {
      return { kind, value: kind };
    }
  }

  return null;
}

export function extractAssetFileMetadata(params: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  category?: AssetCategory;
}): Record<string, unknown> {
  const category = params.category ?? getCategory(params.fileName, params.mimeType);
  const fallbackKind: AssetFileMetadataKind =
    category === "audio"
      ? "audio"
      : category === "texture"
        ? "texture"
        : category === "model"
          ? "model"
          : category === "shader" || category === "script"
            ? "text"
            : "other";

  const metadata: Record<string, unknown> = {
    kind: fallbackKind,
    format: getFileType(params.fileName, params.mimeType),
  };

  if (category === "texture" || params.mimeType.startsWith("image/")) {
    const pbr = detectPbrTextureSet(params.fileName);
    if (pbr) {
      metadata.pbrTextureSet = pbr.kind;
      metadata.pbrTextureSetLabel = pbr.value;
    }

    return metadata;
  }

  if (category === "audio" || params.mimeType.startsWith("audio/")) {
    metadata.kind = "audio";
    const wavHeader = parseWavHeader(params.bytes);
    if (wavHeader) {
      Object.assign(metadata, wavHeader);
    }
    return metadata;
  }

  if (category === "model" || params.mimeType.startsWith("model/")) {
    metadata.kind = "model";
    metadata.fileFormat = getFileType(params.fileName, params.mimeType);
    metadata.hasRig = /\.(gltf|glb|fbx|blend)$/i.test(params.fileName);
    return metadata;
  }

  if (category === "shader" || category === "script") {
    metadata.kind = "text";
  }

  return metadata;
}

function parseWavHeader(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length < 12) return null;
  const riff = new TextDecoder().decode(bytes.slice(0, 4));
  const wave = new TextDecoder().decode(bytes.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = new TextDecoder().decode(bytes.slice(offset, offset + 4));
    const chunkSize = bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);
    const dataOffset = offset + 8;
    if (chunkId === "fmt ") {
      if (dataOffset + 16 > bytes.length) return null;
      const audioFormat = bytes[dataOffset] | (bytes[dataOffset + 1] << 8);
      const channels = bytes[dataOffset + 2] | (bytes[dataOffset + 3] << 8);
      const sampleRate = bytes[dataOffset + 4] |
        (bytes[dataOffset + 5] << 8) |
        (bytes[dataOffset + 6] << 16) |
        (bytes[dataOffset + 7] << 24);
      const bitDepth = bytes[dataOffset + 14] | (bytes[dataOffset + 15] << 8);
      const output: Record<string, unknown> = {
        format: "wav",
        audioFormat,
        channels,
        sampleRate,
        bitDepth,
      };

      let dataSize = 0;
      let foundData = false;
      let cursor = 12;
      while (cursor + 8 <= bytes.length) {
        const currentId = new TextDecoder().decode(bytes.slice(cursor, cursor + 4));
        const currentSize = bytes[cursor + 4] |
          (bytes[cursor + 5] << 8) |
          (bytes[cursor + 6] << 16) |
          (bytes[cursor + 7] << 24);
        const currentOffset = cursor + 8;
        if (currentId === "data") {
          foundData = true;
          dataSize = currentSize;
          break;
        }
        cursor += 8 + currentSize + (currentSize % 2);
      }

      if (foundData && sampleRate > 0 && channels > 0 && bitDepth > 0) {
        output.durationSeconds = Number(
          ((dataSize / (sampleRate * channels * (bitDepth / 8))) || 0).toFixed(3),
        );
      }
      return output;
    }

    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return null;
}

function getFileType(fileName: string, mimeType: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext.startsWith(".") && ext.length > 1) {
    return ext.slice(1);
  }

  const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim().toLowerCase();
  if (!subtype) return "unknown";

  return subtype
    .replace("x-", "")
    .replace("svg+xml", "svg")
    .replace("jpeg", "jpg")
    .replace("mpeg", "mp3")
    .replace(/\+xml$/i, "");
}

export async function readAssets(): Promise<AssetRecord[]> {
  return (await searchAssets({ page: 1, pageSize: 100000 })).assets;
}

function buildSearchMatch(query: string): string {
  return query
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim().replace(/"/g, ""))
    .filter(Boolean)
    .map((term) => `"${term}"*`)
    .join(" AND ");
}

export async function searchAssets(options: AssetSearchOptions = {}): Promise<AssetSearchResult> {
  await ensureStorage();
  const database = getDb();
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 40)));
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (!options.includeDeleted) where.push("a.deleted_at IS NULL");
  if (options.todoOnly) where.push("a.metadata_edited = 0");
  if (options.categories?.length) {
    where.push(`a.category IN (${options.categories.map(() => "?").join(",")})`);
    values.push(...options.categories);
  }
  for (const tag of options.tags ?? []) {
    where.push("EXISTS (SELECT 1 FROM json_each(a.tags_json) WHERE lower(value) = lower(?))");
    values.push(tag);
  }
  for (const license of options.licenses ?? []) {
    where.push("EXISTS (SELECT 1 FROM json_each(a.licenses_json) WHERE lower(value) = lower(?))");
    values.push(license);
  }
  const match = options.query ? buildSearchMatch(options.query) : "";
  if (match) {
    where.push("s.assets_search MATCH ?");
    values.push(match);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = match && (options.sort ?? "best-match") === "best-match"
    ? "bm25(s.assets_search), a.upload_date DESC"
    : ({
        newest: "a.upload_date DESC",
        oldest: "a.upload_date ASC",
        "title-asc": "lower(a.title) ASC, a.id ASC",
        "size-desc": "a.size DESC, a.id ASC",
        "needs-metadata": "a.metadata_edited ASC, a.upload_date DESC",
        "best-match": "a.upload_date DESC",
      }[options.sort ?? "best-match"] ?? "a.upload_date DESC");
  const count = database.prepare(`SELECT COUNT(*) AS count FROM assets a ${match ? "JOIN assets_search s ON s.asset_id = a.id" : ""} ${whereSql}`).get(...values) as { count: number };
  const rows = database.prepare(`
    SELECT a.id, a.title, a.description, a.tags_json, a.licenses_json, a.source_url,
      a.metadata_edited, a.upload_date, a.original_name, a.stored_name, a.file_type,
      a.hash, a.mime_type, a.size, a.category, a.preview_kind, a.width, a.height
    FROM assets a
    ${match ? "JOIN assets_search s ON s.asset_id = a.id" : ""}
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize) as AssetRow[];
  return {
    assets: rows.map((row) => hydrateAsset(database, rowToAssetRecord(row))),
    page,
    pageSize,
    total: Number(count.count),
    totalPages: Math.max(1, Math.ceil(Number(count.count) / pageSize)),
  };
}

export async function setAssetDeleted(id: string, deleted: boolean): Promise<boolean> {
  await ensureStorage();
  const result = getDb().prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(
    deleted ? new Date().toISOString() : null,
    id,
  );
  return Number(result.changes) > 0;
}

export function toAssetView(record: AssetRecord): AssetView {
  return {
    ...record,
    fileUrl: `/api/assets/${record.id}/file`,
    downloadUrl: `/api/assets/${record.id}/download`,
    textPreviewUrl: `/api/assets/${record.id}/text`,
    files: record.files.map((file) => ({
      ...file,
      fileUrl: `/api/assets/${record.id}/files/${encodeURIComponent(file.id)}`,
      downloadUrl: `/api/assets/${record.id}/files/${encodeURIComponent(file.id)}/download`,
      textPreviewUrl: `/api/assets/${record.id}/files/${encodeURIComponent(file.id)}/text`,
    })),
  };
}

export async function saveAsset(params: {
  title: string;
  description?: string;
  tags: string[];
  licenses?: string[];
  sourceUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}): Promise<AssetRecord> {
  await ensureStorage();
  const database = getDb();
  const incomingHash = computeAssetHash(params.bytes);
  await ensureAssetHashes();
  const duplicateRow = database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE hash = ?
        LIMIT 1
      `,
    )
    .get(incomingHash) as AssetRow | undefined;
  const duplicate = duplicateRow
    ? hydrateAsset(database, rowToAssetRecord(duplicateRow))
    : undefined;
  if (duplicate) {
    throw new DuplicateAssetError(duplicate);
  }

  const id = randomUUID();
  const ext = path.extname(params.fileName);
  const storedName = `${id}${ext}`;
  const category = getCategory(params.fileName, params.mimeType);
  const previewKind = getPreviewKind(
    category,
    params.fileName,
    params.mimeType,
  );

  // Attempt to read image dimensions for textures/images
  let width: number | undefined;
  let height: number | undefined;
  if (previewKind === "image") {
    try {
      const { default: sizeOf } = await import("image-size");
      const dims = sizeOf(Buffer.from(params.bytes));
      if (
        dims &&
        typeof dims.width === "number" &&
        typeof dims.height === "number"
      ) {
        width = dims.width;
        height = dims.height;
      }
    } catch (err) {
      // Non-fatal: if image-size isn't available or fails, continue without dims
      // eslint-disable-next-line no-console
      console.warn("Could not determine image dimensions:", err);
    }
  }

  const textSnippet =
    previewKind === "text"
      ? textDecoder.decode(params.bytes.slice(0, 4_000))
      : undefined;

  const autoMetadata = await generateAutoMetadata({
    title: params.title,
    originalName: params.fileName,
    category,
    mimeType: params.mimeType || "application/octet-stream",
    existingTags: params.tags,
    existingDescription: params.description ?? "",
    textSnippet,
    imageFile:
      category === "texture"
        ? {
            mimeType: params.mimeType || "application/octet-stream",
            bytes: params.bytes,
          }
        : undefined,
    audioFile:
      category === "audio"
        ? (() => {
            const format = getAudioAttachmentFormat(
              params.fileName,
              params.mimeType || "application/octet-stream",
            );
            if (!format) return undefined;
            return {
              format,
              bytes: params.bytes,
            };
          })()
        : undefined,
  });

  const fileMetadata = extractAssetFileMetadata({
    fileName: params.fileName,
    mimeType: params.mimeType || "application/octet-stream",
    bytes: params.bytes,
    category,
  });

  const normalizedLicenses = (params.licenses ?? [])
    .map((license) => license.trim())
    .filter(Boolean);
  const normalizedSourceUrl = params.sourceUrl?.trim() ?? "";
  const hasInitialMetadata =
    normalizedSourceUrl.length > 0 || normalizedLicenses.length > 0;

  const record: AssetRecord = {
    id,
    title: params.title,
    description: autoMetadata.description,
    tags: autoMetadata.tags,
    licenses:
      normalizedLicenses.length > 0 ? normalizedLicenses : [DEFAULT_LICENSE],
    sourceUrl: normalizedSourceUrl,
    metadataEdited: hasInitialMetadata,
    uploadDate: new Date().toISOString(),
    originalName: params.fileName,
    storedName,
    fileType: getFileType(
      params.fileName,
      params.mimeType || "application/octet-stream",
    ),
    hash: incomingHash,
    mimeType: params.mimeType || "application/octet-stream",
    size: params.size,
    category,
    previewKind,
    width,
    height,
    files: [],
  };

  const file: AssetFileRecord = {
    id: randomUUID(),
    assetId: id,
    role: "source",
    variant: "",
    originalName: record.originalName,
    storedName: record.storedName,
    fileType: record.fileType,
    hash: record.hash,
    mimeType: record.mimeType,
    size: record.size,
    category: record.category,
    previewKind: record.previewKind,
    width: record.width,
    height: record.height,
    metadata: fileMetadata,
    createdAt: record.uploadDate,
  };

  await writeFile(path.join(uploadsDir, storedName), params.bytes);

  try {
    insertRecord(database, record);
    insertAssetFile(database, file);
    indexAsset(database, record);
  } catch (errorValue) {
    await rm(path.join(uploadsDir, storedName), { force: true });

    const message =
      errorValue instanceof Error ? errorValue.message : String(errorValue);
    if (message.includes("UNIQUE constraint failed: assets.hash")) {
      const existing = database
        .prepare(
          `
            SELECT
              id,
              title,
              description,
              tags_json,
              licenses_json,
              source_url,
              metadata_edited,
              upload_date,
              original_name,
              stored_name,
              file_type,
              hash,
              mime_type,
              size,
              category,
              preview_kind,
              width,
              height
            FROM assets
            WHERE hash = ?
            LIMIT 1
          `,
        )
        .get(incomingHash) as AssetRow | undefined;
      if (existing) {
        throw new DuplicateAssetError(
          hydrateAsset(database, rowToAssetRecord(existing)),
        );
      }
    }
    throw errorValue;
  }

  return { ...record, files: [file] };
}

export async function getAssetById(
  id: string,
): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const database = getDb();
  const row = database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as AssetRow | undefined;

  return row ? hydrateAsset(database, rowToAssetRecord(row)) : undefined;
}

export async function getAssetFileById(
  assetId: string,
  fileId: string,
): Promise<AssetFileRecord | undefined> {
  await ensureStorage();
  const database = getDb();
  const row = database
    .prepare(
      `
        SELECT id, asset_id, role, variant, original_name, stored_name, file_type,
          hash, mime_type, size, category, preview_kind, width, height,
          metadata_json, created_at
        FROM asset_files
        WHERE asset_id = ? AND id = ?
        LIMIT 1
      `,
    )
    .get(assetId, fileId) as AssetFileRow | undefined;
  return row ? rowToAssetFile(row) : undefined;
}

type AssetFileInput = {
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  role?: AssetFileRole;
  variant?: string;
  metadata?: Record<string, unknown>;
};

async function buildAssetFile(
  assetId: string,
  input: AssetFileInput,
): Promise<AssetFileRecord> {
  const mimeType = input.mimeType || "application/octet-stream";
  const category = getCategory(input.fileName, mimeType);
  const previewKind = getPreviewKind(category, input.fileName, mimeType);
  let width: number | undefined;
  let height: number | undefined;
  if (previewKind === "image") {
    try {
      const { default: sizeOf } = await import("image-size");
      const dimensions = sizeOf(Buffer.from(input.bytes));
      width = dimensions.width;
      height = dimensions.height;
    } catch {
      // Image dimensions are optional metadata.
    }
  }

  const fileId = randomUUID();
  const metadata = input.metadata ??
    extractAssetFileMetadata({
      fileName: input.fileName,
      mimeType,
      bytes: input.bytes,
      category,
    });

  return {
    id: fileId,
    assetId,
    role: normalizeFileRole(input.role ?? "other"),
    variant: input.variant?.trim() ?? "",
    originalName: input.fileName,
    storedName: `${fileId}${path.extname(input.fileName)}`,
    fileType: getFileType(input.fileName, mimeType),
    hash: computeAssetHash(input.bytes),
    mimeType,
    size: input.size,
    category,
    previewKind,
    width,
    height,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

export async function addAssetFile(
  assetId: string,
  input: AssetFileInput,
): Promise<AssetFileRecord | undefined> {
  await ensureStorage();
  const database = getDb();
  if (!(await getAssetById(assetId))) {
    return undefined;
  }

  const file = await buildAssetFile(assetId, input);
  const duplicateRow = database
    .prepare("SELECT asset_id FROM asset_files WHERE hash = ? LIMIT 1")
    .get(file.hash ?? null) as { asset_id: string } | undefined;
  if (duplicateRow) {
    const duplicate = await getAssetById(duplicateRow.asset_id);
    if (duplicate) {
      throw new DuplicateAssetError(duplicate);
    }
  }

  await writeFile(getStoredFilePath(file.storedName), input.bytes);
  try {
    insertAssetFile(database, file);
  } catch (errorValue) {
    await rm(getStoredFilePath(file.storedName), { force: true });
    throw errorValue;
  }
  return file;
}

export async function replaceAssetChildFile(
  assetId: string,
  fileId: string,
  replacement: AssetFileInput,
): Promise<AssetFileRecord | undefined> {
  await ensureStorage();
  const database = getDb();
  const current = await getAssetFileById(assetId, fileId);
  if (!current) {
    return undefined;
  }

  const replacementFile = await buildAssetFile(assetId, replacement);
  replacementFile.id = fileId;
  const duplicateRow = database
    .prepare("SELECT asset_id FROM asset_files WHERE hash = ? AND id != ? LIMIT 1")
    .get(replacementFile.hash ?? null, fileId) as { asset_id: string } | undefined;
  if (duplicateRow) {
    const duplicate = await getAssetById(duplicateRow.asset_id);
    if (duplicate) {
      throw new DuplicateAssetError(duplicate);
    }
  }

  const replacementPath = getStoredFilePath(replacementFile.storedName);
  const currentPath = getStoredFilePath(current.storedName);
  await writeFile(replacementPath, replacement.bytes);
  try {
    database
      .prepare(
        `
          UPDATE asset_files SET
            role = @role, variant = @variant, original_name = @original_name,
            stored_name = @stored_name, file_type = @file_type, hash = @hash,
            mime_type = @mime_type, size = @size, category = @category,
            preview_kind = @preview_kind, width = @width, height = @height,
            metadata_json = @metadata_json, created_at = @created_at
          WHERE asset_id = @asset_id AND id = @id
        `,
      )
      .run({
        id: fileId,
        asset_id: assetId,
        role: replacementFile.role,
        variant: replacementFile.variant,
        original_name: replacementFile.originalName,
        stored_name: replacementFile.storedName,
        file_type: replacementFile.fileType,
        hash: replacementFile.hash ?? null,
        mime_type: replacementFile.mimeType,
        size: replacementFile.size,
        category: replacementFile.category,
        preview_kind: replacementFile.previewKind,
        width: replacementFile.width ?? null,
        height: replacementFile.height ?? null,
        metadata_json: JSON.stringify(replacementFile.metadata ?? {}),
        created_at: replacementFile.createdAt,
      });
  } catch (errorValue) {
    await rm(replacementPath, { force: true });
    throw errorValue;
  }

  if (replacementFile.storedName !== current.storedName) {
    await rm(currentPath, { force: true });
  }
  return replacementFile;
}

export async function listAssetRelations(assetId: string): Promise<AssetRelation[]> {
  await ensureStorage();
  const rows = getDb()
    .prepare(
      "SELECT parent_asset_id, child_asset_id, relation_type FROM asset_relations WHERE parent_asset_id = ? OR child_asset_id = ? ORDER BY parent_asset_id, child_asset_id",
    )
    .all(assetId, assetId) as Array<{
    parent_asset_id: string;
    child_asset_id: string;
    relation_type: string;
  }>;
  return rows.map((row) => ({
    parentAssetId: row.parent_asset_id,
    childAssetId: row.child_asset_id,
    relationType:
      row.relation_type === "variant" || row.relation_type === "derived-from"
        ? row.relation_type
        : "contains",
  }));
}

export async function addAssetRelation(
  parentAssetId: string,
  childAssetId: string,
  relationType: AssetRelation["relationType"],
): Promise<boolean> {
  await ensureStorage();
  const database = getDb();
  const assets = database
    .prepare("SELECT id FROM assets WHERE id IN (?, ?)")
    .all(parentAssetId, childAssetId) as Array<{ id: string }>;
  if (assets.length !== 2 || parentAssetId === childAssetId) return false;
  database
    .prepare(
      "INSERT OR IGNORE INTO asset_relations (parent_asset_id, child_asset_id, relation_type) VALUES (?, ?, ?)",
    )
    .run(parentAssetId, childAssetId, relationType);
  return true;
}

export async function updateAssetMetadata(
  id: string,
  updates: {
    title: string;
    description: string;
    tags: string[];
    licenses: string[];
    sourceUrl: string;
  },
): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const database = getDb();
  const result = database
    .prepare(
      `
        UPDATE assets
        SET
          title = @title,
          description = @description,
          tags_json = @tags_json,
          licenses_json = @licenses_json,
          source_url = @source_url,
          metadata_edited = 1
        WHERE id = @id
      `,
    )
    .run({
      id,
      title: updates.title,
      description: updates.description,
      tags_json: JSON.stringify(updates.tags),
      licenses_json: JSON.stringify(updates.licenses),
      source_url: updates.sourceUrl,
    });

  if (result.changes === 0) {
    return undefined;
  }

  const updated = await getAssetById(id);
  if (updated) indexAsset(database, updated);
  return updated;
}

export async function replaceAssetFile(
  id: string,
  replacement: {
    fileName: string;
    mimeType: string;
    size: number;
    bytes: Uint8Array;
  },
): Promise<AssetRecord | undefined> {
  await ensureStorage();
  const database = getDb();
  await ensureAssetHashes();

  const currentRow = database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE id = ?
        LIMIT 1
      `,
    )
    .get(id) as AssetRow | undefined;
  if (!currentRow) {
    return undefined;
  }

  const incomingHash = computeAssetHash(replacement.bytes);
  const duplicateRow = database
    .prepare(
      `
        SELECT
          id,
          title,
          description,
          tags_json,
          licenses_json,
          source_url,
          metadata_edited,
          upload_date,
          original_name,
          stored_name,
          file_type,
          hash,
          mime_type,
          size,
          category,
          preview_kind,
          width,
          height
        FROM assets
        WHERE hash = ? AND id != ?
        LIMIT 1
      `,
    )
    .get(incomingHash, id) as AssetRow | undefined;
  const duplicate = duplicateRow
    ? hydrateAsset(database, rowToAssetRecord(duplicateRow))
    : undefined;
  if (duplicate) {
    throw new DuplicateAssetError(duplicate);
  }

  const current = rowToAssetRecord(currentRow);
  const ext = path.extname(replacement.fileName);
  const storedName = `${id}${ext}`;
  const category = getCategory(replacement.fileName, replacement.mimeType);
  const previewKind = getPreviewKind(
    category,
    replacement.fileName,
    replacement.mimeType,
  );

  let width: number | undefined;
  let height: number | undefined;
  if (previewKind === "image") {
    try {
      const { default: sizeOf } = await import("image-size");
      const dims = sizeOf(Buffer.from(replacement.bytes));
      if (
        dims &&
        typeof dims.width === "number" &&
        typeof dims.height === "number"
      ) {
        width = dims.width;
        height = dims.height;
      }
    } catch {
      // Ignore image dimension probe failures.
    }
  }

  const replacementPath = path.join(uploadsDir, storedName);
  const currentPath = path.join(uploadsDir, current.storedName);
  await writeFile(replacementPath, replacement.bytes);

  const uploadDate = new Date().toISOString();
  try {
    database
      .prepare(
        `
          UPDATE assets
          SET
            original_name = @original_name,
            stored_name = @stored_name,
            file_type = @file_type,
            hash = @hash,
            mime_type = @mime_type,
            size = @size,
            category = @category,
            preview_kind = @preview_kind,
            width = @width,
            height = @height,
            upload_date = @upload_date,
            metadata_edited = 0
          WHERE id = @id
        `,
      )
      .run({
        id,
        original_name: replacement.fileName,
        stored_name: storedName,
        file_type: getFileType(
          replacement.fileName,
          replacement.mimeType || "application/octet-stream",
        ),
        hash: incomingHash,
        mime_type: replacement.mimeType || "application/octet-stream",
        size: replacement.size,
        category,
        preview_kind: previewKind,
        width: width ?? null,
        height: height ?? null,
        upload_date: uploadDate,
      });
  } catch (errorValue) {
    await rm(replacementPath, { force: true });
    const message =
      errorValue instanceof Error ? errorValue.message : String(errorValue);
    if (message.includes("UNIQUE constraint failed: assets.hash")) {
      const existing = database
        .prepare(
          `
            SELECT
              id,
              title,
              description,
              tags_json,
              licenses_json,
              source_url,
              metadata_edited,
              upload_date,
              original_name,
              stored_name,
              file_type,
              hash,
              mime_type,
              size,
              category,
              preview_kind,
              width,
              height
            FROM assets
            WHERE hash = ? AND id != ?
            LIMIT 1
          `,
        )
        .get(incomingHash, id) as AssetRow | undefined;
      if (existing) {
        throw new DuplicateAssetError(
          hydrateAsset(database, rowToAssetRecord(existing)),
        );
      }
    }
    throw errorValue;
  }

  const primaryFile = database
    .prepare(
      "SELECT id FROM asset_files WHERE asset_id = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(id) as { id: string } | undefined;
  if (primaryFile) {
    database
      .prepare(
        `
          UPDATE asset_files SET
            original_name = ?, stored_name = ?, file_type = ?, hash = ?,
            mime_type = ?, size = ?, category = ?, preview_kind = ?,
            width = ?, height = ?, created_at = ?, metadata_json = ?
          WHERE id = ? AND asset_id = ?
        `,
      )
      .run(
        replacement.fileName,
        storedName,
        getFileType(
          replacement.fileName,
          replacement.mimeType || "application/octet-stream",
        ),
        incomingHash,
        replacement.mimeType || "application/octet-stream",
        replacement.size,
        category,
        previewKind,
        width ?? null,
        height ?? null,
        uploadDate,
        JSON.stringify(
          extractAssetFileMetadata({
            fileName: replacement.fileName,
            mimeType: replacement.mimeType || "application/octet-stream",
            bytes: replacement.bytes,
            category,
          }),
        ),
        primaryFile.id,
        id,
      );
  }

  if (storedName !== current.storedName) {
    await rm(currentPath, { force: true });
  }

  return getAssetById(id);
}

export async function deleteAsset(id: string): Promise<boolean> {
  await ensureStorage();
  const database = getDb();
  const rows = database
    .prepare("SELECT stored_name FROM asset_files WHERE asset_id = ?")
    .all(id) as Array<{ stored_name: string }>;

  if (rows.length === 0) {
    return false;
  }

  database.prepare("DELETE FROM assets WHERE id = ?").run(id);
  for (const row of rows) {
    await rm(getStoredFilePath(row.stored_name), { force: true });
  }
  return true;
}

export function getStoredFilePath(storedName: string): string {
  const resolvedPath = path.resolve(uploadsDir, storedName);
  const relativePath = path.relative(uploadsDir, resolvedPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Stored file path escapes the uploads directory.");
  }

  return resolvedPath;
}
