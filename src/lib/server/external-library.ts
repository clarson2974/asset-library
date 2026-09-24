import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ExternalLibraryScanStatus = "ok" | "warning" | "error";

export type ExternalLibraryConfig = {
  enabled: boolean;
  rootDirectory: string;
  roots: string[];
  ignorePatterns: string[];
  supportedExtensions: string[];
};

export type ExternalLibraryEntry = {
  relativePath: string;
  fullPath: string;
  size: number;
  lastModified: string;
  status: "discovered" | "modified" | "missing" | "ignored" | "unavailable";
  reason?: string;
};

export type ExternalLibraryScanResult = {
  status: ExternalLibraryScanStatus;
  scannedAt: string;
  rootDirectory: string;
  discovered: ExternalLibraryEntry[];
  modified: ExternalLibraryEntry[];
  missing: ExternalLibraryEntry[];
  ignored: ExternalLibraryEntry[];
  unavailable: ExternalLibraryEntry[];
};

export type ExternalLibraryScanStateFile = {
  lastScan?: ExternalLibraryScanResult;
};

const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".glb",
  ".gltf",
  ".obj",
  ".fbx",
  ".blend",
  ".png",
  ".jpg",
  ".jpeg",
  ".tga",
  ".webp",
  ".wav",
  ".mp3",
  ".ogg",
  ".flac",
  ".mp4",
  ".mov",
  ".pdf",
  ".txt",
  ".md",
];

const dataRoot = path.resolve(
  process.env.ASSET_LIBRARY_DATA_DIR?.trim() || path.join(process.cwd(), "data"),
);
const configPath = path.join(dataRoot, "external-library-config.json");
const statePath = path.join(dataRoot, "external-library-scan-state.json");

function ensureDataDirectory(): void {
  mkdirSync(dataRoot, { recursive: true });
}

function defaultConfig(): ExternalLibraryConfig {
  return {
    enabled: false,
    rootDirectory:
      process.env.ASSET_LIBRARY_EXTERNAL_ROOT?.trim() ||
      path.join(dataRoot, "external-library"),
    roots: [],
    ignorePatterns: ["**/.DS_Store", "**/Thumbs.db", "**/*.tmp"],
    supportedExtensions: DEFAULT_SUPPORTED_EXTENSIONS,
  };
}

function normalizeExtensions(extensions: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (extensions ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
    ),
  );
}

function isSafeWithinRoot(rootDirectory: string, resolvedPath: string): boolean {
  const rootResolved = path.resolve(rootDirectory);
  const relative = path.relative(rootResolved, resolvedPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matchesIgnorePattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let regexSource = "^";

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];

    if (character === "*") {
      if (normalizedPattern[index + 1] === "*") {
        if (normalizedPattern[index + 2] === "/") {
          regexSource += "(?:.*/)?";
          index += 2;
        } else {
          regexSource += ".*";
          index += 1;
        }
      } else {
        regexSource += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      regexSource += "[^/]";
      continue;
    }

    if ([".", "+", "(", ")", "[", "]", "{", "}", "^", "$", "|", "/"].includes(character)) {
      regexSource += `\\${character}`;
      continue;
    }

    regexSource += character;
  }

  regexSource += "$";
  return new RegExp(regexSource).test(relativePath.replace(/\\/g, "/"));
}

function shouldIgnore(relativePath: string, config: ExternalLibraryConfig): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  return config.ignorePatterns.some((pattern) => matchesIgnorePattern(normalized, pattern));
}

function toSafeRelativePath(baseDirectory: string, candidatePath: string): string {
  const relative = path.relative(baseDirectory, candidatePath).replace(/\\/g, "/");
  return relative.startsWith("../") ? "" : relative;
}

function ensureParentDirectory(rootDirectory: string): void {
  if (!existsSync(rootDirectory)) {
    return;
  }

  const realRoot = path.resolve(rootDirectory);
  const stats = lstatSync(realRoot);
  if (stats.isSymbolicLink()) {
    throw new Error("Configured external library root cannot be a symlink.");
  }
}

function readStateFile(): ExternalLibraryScanStateFile {
  try {
    ensureDataDirectory();
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as ExternalLibraryScanStateFile;
    return parsed && typeof parsed === "object" ? parsed : { lastScan: undefined };
  } catch {
    return { lastScan: undefined };
  }
}

function writeStateFile(nextState: ExternalLibraryScanStateFile): void {
  ensureDataDirectory();
  writeFileSync(statePath, JSON.stringify(nextState, null, 2), "utf8");
}

function normalizeConfigInput(input: Partial<ExternalLibraryConfig>): Partial<ExternalLibraryConfig> {
  const next: Partial<ExternalLibraryConfig> = { ...input };
  if (Array.isArray(input.roots)) {
    next.roots = input.roots.map((root) => root.trim()).filter(Boolean);
  }
  if (Array.isArray(input.ignorePatterns)) {
    next.ignorePatterns = input.ignorePatterns.map((entry) => entry.trim()).filter(Boolean);
  }
  if (Array.isArray(input.supportedExtensions)) {
    next.supportedExtensions = normalizeExtensions(input.supportedExtensions);
  }
  if (typeof input.rootDirectory === "string") {
    next.rootDirectory = input.rootDirectory.trim();
  }
  return next;
}

export async function getExternalLibraryConfig(): Promise<ExternalLibraryConfig> {
  ensureDataDirectory();
  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Partial<ExternalLibraryConfig>;
    return {
      ...defaultConfig(),
      ...normalizeConfigInput(existing),
      roots: Array.isArray(existing.roots) ? existing.roots.map((root) => root.trim()).filter(Boolean) : [],
      ignorePatterns: Array.isArray(existing.ignorePatterns)
        ? existing.ignorePatterns.map((pattern) => pattern.trim()).filter(Boolean)
        : defaultConfig().ignorePatterns,
      supportedExtensions: normalizeExtensions(
        Array.isArray(existing.supportedExtensions)
          ? existing.supportedExtensions
          : defaultConfig().supportedExtensions,
      ),
    };
  } catch {
    const next = defaultConfig();
    writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

export async function updateExternalLibraryConfig(
  updates: Partial<ExternalLibraryConfig>,
): Promise<ExternalLibraryConfig> {
  const current = await getExternalLibraryConfig();
  const next = {
    ...current,
    ...normalizeConfigInput(updates),
    rootDirectory: updates.rootDirectory?.trim() || current.rootDirectory || defaultConfig().rootDirectory,
    roots: updates.roots ?? current.roots,
    ignorePatterns: updates.ignorePatterns ?? current.ignorePatterns,
    supportedExtensions: updates.supportedExtensions ?? current.supportedExtensions,
    enabled: typeof updates.enabled === "boolean" ? updates.enabled : current.enabled,
  };

  ensureDataDirectory();
  writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function isSupportedFile(relativePath: string, config: ExternalLibraryConfig): boolean {
  const ext = path.extname(relativePath).toLowerCase();
  if (config.supportedExtensions.length === 0) {
    return true;
  }
  return config.supportedExtensions.includes(ext);
}

function ensureNoSymlinkEscape(baseDirectory: string, candidatePath: string): string {
  const root = path.resolve(baseDirectory);
  const resolvedPath = path.resolve(candidatePath);
  if (!isSafeWithinRoot(root, resolvedPath)) {
    throw new Error(`Resolved path is outside the configured root: ${candidatePath}`);
  }

  let current = root;
  const relativeSegments = path.relative(root, resolvedPath).split(path.sep).filter(Boolean);
  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Symlink escape detected in ${candidatePath}`);
      }
    } catch {
      // Nonexistent path segments are acceptable here; they are still under the root.
    }
  }

  return resolvedPath;
}

export function resolveExternalLibraryPath(rootDirectory: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error("External library path must be provided.");
  }

  if (path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed for external library scans.");
  }

  return ensureNoSymlinkEscape(rootDirectory, path.join(rootDirectory, requestedPath));
}

function listFilesRecursively(directory: string, rootDirectory: string, config: ExternalLibraryConfig): ExternalLibraryEntry[] {
  const discovered: ExternalLibraryEntry[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = toSafeRelativePath(rootDirectory, fullPath);

    if (entry.isSymbolicLink()) {
      discovered.push({
        relativePath: relativePath || entry.name,
        fullPath,
        size: 0,
        lastModified: new Date(0).toISOString(),
        status: "ignored",
        reason: "symlink",
      });
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      discovered.push(...listFilesRecursively(fullPath, rootDirectory, config));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const normalizedRelative = relativePath.replace(/\\/g, "/");
    if (shouldIgnore(normalizedRelative, config)) {
      discovered.push({
        relativePath: normalizedRelative,
        fullPath,
        size: statSync(fullPath).size,
        lastModified: new Date(statSync(fullPath).mtimeMs).toISOString(),
        status: "ignored",
        reason: "ignore-pattern",
      });
      continue;
    }

    if (!isSupportedFile(normalizedRelative, config)) {
      continue;
    }

    const fileStats = statSync(fullPath);
    discovered.push({
      relativePath: normalizedRelative,
      fullPath,
      size: fileStats.size,
      lastModified: new Date(fileStats.mtimeMs).toISOString(),
      status: "discovered",
    });
  }

  return discovered;
}

export async function scanExternalLibraries(): Promise<ExternalLibraryScanResult> {
  const config = await getExternalLibraryConfig();
  const rootDirectory = config.rootDirectory || defaultConfig().rootDirectory;
  const rootPath = path.resolve(rootDirectory);

  const state = readStateFile();
  const previousMap = new Map(
    (state.lastScan?.discovered ?? [])
      .concat(state.lastScan?.modified ?? [])
      .concat(state.lastScan?.missing ?? [])
      .map((entry) => [entry.relativePath, entry]),
  );

  const scanResult: ExternalLibraryScanResult = {
    status: "ok",
    scannedAt: new Date().toISOString(),
    rootDirectory: rootPath,
    discovered: [],
    modified: [],
    missing: [],
    ignored: [],
    unavailable: [],
  };

  if (!config.enabled) {
    scanResult.status = "warning";
    scanResult.unavailable.push({
      relativePath: ".",
      fullPath: rootPath,
      size: 0,
      lastModified: new Date(0).toISOString(),
      status: "unavailable",
      reason: "disabled",
    });
    writeStateFile({ lastScan: scanResult });
    return scanResult;
  }

  try {
    ensureParentDirectory(rootPath);
  } catch (error) {
    scanResult.status = "error";
    scanResult.unavailable.push({
      relativePath: ".",
      fullPath: rootPath,
      size: 0,
      lastModified: new Date(0).toISOString(),
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    });
    writeStateFile({ lastScan: scanResult });
    return scanResult;
  }

  if (!existsSync(rootPath) || !statSync(rootPath, { throwIfNoEntry: false })?.isDirectory()) {
    scanResult.status = "warning";
    scanResult.unavailable.push({
      relativePath: ".",
      fullPath: rootPath,
      size: 0,
      lastModified: new Date(0).toISOString(),
      status: "unavailable",
      reason: "root-missing",
    });
    writeStateFile({ lastScan: scanResult });
    return scanResult;
  }

  const roots = config.roots.length > 0 ? config.roots : ["."];

  for (const rootEntry of roots) {
    const rootCandidate = path.resolve(rootPath, rootEntry);
    if (!isSafeWithinRoot(rootPath, rootCandidate)) {
      scanResult.status = "warning";
      scanResult.unavailable.push({
        relativePath: rootEntry,
        fullPath: rootCandidate,
        size: 0,
        lastModified: new Date(0).toISOString(),
        status: "unavailable",
        reason: "root-outside-configured-area",
      });
      continue;
    }

    if (!existsSync(rootCandidate)) {
      scanResult.status = "warning";
      scanResult.unavailable.push({
        relativePath: rootEntry,
        fullPath: rootCandidate,
        size: 0,
        lastModified: new Date(0).toISOString(),
        status: "unavailable",
        reason: "missing-root",
      });
      continue;
    }

    const candidates = listFilesRecursively(rootCandidate, rootCandidate, config);
    for (const candidate of candidates) {
      if (candidate.status === "ignored") {
        scanResult.ignored.push(candidate);
        continue;
      }

      const previous = previousMap.get(candidate.relativePath);
      if (!previous) {
        scanResult.discovered.push(candidate);
        continue;
      }

      if (
        previous.size !== candidate.size ||
        new Date(previous.lastModified).getTime() !== new Date(candidate.lastModified).getTime()
      ) {
        scanResult.modified.push({ ...candidate, status: "modified" });
      } else {
        scanResult.discovered.push({ ...candidate, status: "discovered" });
      }
    }
  }

  const trackedEntries = new Set(
    scanResult.discovered.map((entry) => entry.relativePath).concat(
      scanResult.modified.map((entry) => entry.relativePath),
      scanResult.ignored.map((entry) => entry.relativePath),
    ),
  );

  for (const [relativePath, previous] of previousMap) {
    if (!trackedEntries.has(relativePath)) {
      const missingEntry: ExternalLibraryEntry = {
        relativePath,
        fullPath: previous.fullPath,
        size: previous.size,
        lastModified: previous.lastModified,
        status: "missing",
        reason: "missing-from-scan",
      };
      scanResult.missing.push(missingEntry);
    }
  }

  if (scanResult.missing.length > 0 || scanResult.unavailable.length > 0) {
    scanResult.status = "warning";
  }

  writeStateFile({
    lastScan: scanResult,
  });

  return scanResult;
}

export async function getExternalLibraryScanState(): Promise<ExternalLibraryScanStateFile> {
  const state = readStateFile();
  return state;
}
