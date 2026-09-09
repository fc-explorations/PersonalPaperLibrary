import busboy from "busboy";
import Database from "better-sqlite3";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingHttpHeaders } from "node:http";
import * as unzipper from "unzipper";
import type { FileStorage } from "./storage.js";
import { APP_VERSION } from "../version.js";

const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver") as { ZipArchive: new (options: { forceZip64: boolean }) => import("archiver").Archiver };

export const SNAPSHOT_FORMAT = "personal-paper-library-snapshot";
export const SNAPSHOT_FORMAT_VERSION = 1;
export const SNAPSHOT_APP_VERSION = APP_VERSION;
export const SNAPSHOT_PENDING_FILE = "pending-snapshot-restore.json";

const SNAPSHOT_MANIFEST_MAX_BYTES = 1024 * 1024;
const DATABASE_ARTIFACTS = ["library.sqlite", "library.sqlite-wal", "library.sqlite-shm", "library.sqlite-journal"];
const REQUIRED_SCHEMA: Record<string, string[]> = {
  schema_migrations: ["name", "applied_at"],
  papers: ["id", "arxiv_id", "arxiv_base_id", "title", "abstract", "published_date", "updated_date", "year", "primary_category", "categories", "journal_ref", "accepted_venue", "doi", "isbn", "bibtex", "source_url", "arxiv_url", "r2_key", "pdf_sha256", "metadata_source", "created_at", "updated_at"],
  authors: ["id", "display_name"],
  paper_authors: ["paper_id", "author_id", "author_order"],
  tags: ["id", "name", "created_at"],
  paper_tags: ["paper_id", "tag_id"],
  app_settings: ["name", "value", "updated_at"],
  paper_summaries: ["paper_id", "content", "quick_summary", "provider", "model", "generated_at", "duration_ms", "source_pdf_sha256", "prompt_version", "status", "error_message", "updated_at"],
  paper_questions: ["paper_id", "question_id", "group_id", "group_title", "group_description", "question_order", "label", "prompt", "definition_hash", "is_custom", "is_active", "created_at"],
  paper_question_answers: ["paper_id", "question_id", "content", "quick_summary", "provider", "model", "generated_at", "duration_ms", "source_pdf_sha256", "prompt_version", "question_definition_hash", "status", "error_message", "updated_at"],
  paper_search_index: ["paper_id", "search_text", "content_hash", "embedding_json", "embedding_provider", "embedding_model", "status", "error_message", "updated_at"],
  paper_search_fts: ["paper_id", "content"],
};
const REQUIRED_MIGRATIONS = [
  "0001_initial.sql",
  "0002_ai_analysis.sql",
  "0003_custom_questions.sql",
  "0004_analysis_duration.sql",
  "0005_accepted_venue.sql",
  "0006_question_definition_hash.sql",
  "0007_question_activity.sql",
  "0008_library_search.sql",
  "0009_isbn.sql",
  "0010_no_pdf_tag.sql",
  "0011_bibtex.sql",
  "0012_quick_analysis_summaries.sql",
];

type SnapshotArchive = {
  stream: ReadableStream<Uint8Array>;
  done: Promise<void>;
};

type PendingSnapshot = {
  token: string;
  directory: string;
  createdAt: string;
};

function snapshotError(code: string): Error {
  return new Error(code);
}

function safePdfPath(path: string): string | undefined {
  const match = path.match(/^pdfs\/([a-z0-9_-]+)\.pdf$/i);
  return match ? match[1] : undefined;
}

function validateArchivePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".." || part === "")) {
    throw snapshotError("SNAPSHOT_PATH_INVALID");
  }
}

function pendingPath(root: string): string {
  return join(root, SNAPSHOT_PENDING_FILE);
}

function snapshotRoot(root: string): string {
  return resolve(root);
}

function normalizedLimit(maxBytes: number): number {
  return Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Number.MAX_SAFE_INTEGER;
}

function isSnapshotDirectory(root: string, directory: string): boolean {
  const rel = relative(snapshotRoot(root), resolve(directory));
  return /^\.snapshot-restore-[a-z0-9]+$/i.test(rel);
}

function isUploadDirectory(root: string, directory: string): boolean {
  const rel = relative(snapshotRoot(root), resolve(directory));
  return /^\.snapshot-upload-[a-z0-9]+$/i.test(rel);
}

function readPendingSnapshot(root: string): PendingSnapshot {
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(pendingPath(root), "utf8"));
  } catch {
    throw snapshotError("SNAPSHOT_PENDING_INVALID");
  }
  if (!marker || typeof marker !== "object") throw snapshotError("SNAPSHOT_PENDING_INVALID");
  const value = marker as Record<string, unknown>;
  if (typeof value.token !== "string" || !/^\.snapshot-restore-[a-z0-9]+$/i.test(value.token) || typeof value.directory !== "string" || typeof value.createdAt !== "string") {
    throw snapshotError("SNAPSHOT_PENDING_INVALID");
  }
  if (!isSnapshotDirectory(root, value.directory) || relative(snapshotRoot(root), resolve(value.directory)) !== value.token) throw snapshotError("SNAPSHOT_RESTORE_PATH_INVALID");
  return { token: value.token, directory: resolve(value.directory), createdAt: value.createdAt };
}

type ExtractionState = { bytes: number; maxBytes: number };

function extractionLimiter(state: ExtractionState): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      state.bytes += (chunk as Uint8Array).byteLength;
      if (state.bytes > state.maxBytes) callback(snapshotError("SNAPSHOT_TOO_LARGE"));
      else callback(null, chunk);
    },
  });
}

async function copyArchiveEntry(entry: unzipper.File, destination: string, state: ExtractionState): Promise<void> {
  await pipeline(entry.stream(), extractionLimiter(state), createWriteStream(destination));
}

async function readArchiveEntry(entry: unzipper.File, state: ExtractionState): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of entry.stream()) {
    state.bytes += (chunk as Uint8Array).byteLength;
    if (state.bytes > state.maxBytes) throw snapshotError("SNAPSHOT_TOO_LARGE");
    if (state.bytes > SNAPSHOT_MANIFEST_MAX_BYTES) throw snapshotError("SNAPSHOT_MANIFEST_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function cleanupDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

export async function createSnapshotArchive(db: Database.Database, storage: FileStorage): Promise<SnapshotArchive> {
  const directory = await mkdtemp(join(storage.root, ".snapshot-"));
  const databasePath = join(directory, "library.sqlite");
  try {
    await db.backup(databasePath);
    const pdfRows = db.prepare("SELECT id FROM papers WHERE r2_key IS NOT NULL ORDER BY id").iterate() as Iterable<{ id: string }>;
    const pdfs: Array<{ id: string; path: string }> = [];
    for (const row of pdfRows) {
      const path = storage.getPath(row.id);
      if (!existsSync(path)) throw snapshotError("SNAPSHOT_PDF_MISSING");
      pdfs.push({ id: row.id, path });
    }

    const archive = new ZipArchive({ forceZip64: true });
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolveDoneValue, rejectDoneValue) => {
      resolveDone = resolveDoneValue;
      rejectDone = rejectDoneValue;
    });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) rejectDone(error);
      else resolveDone();
      void cleanupDirectory(directory);
    };
    archive.once("error", (error: unknown) => finish(error));
    archive.once("close", () => finish());
    archive.once("end", () => finish());
    archive.append(Buffer.from(JSON.stringify({
      format: SNAPSHOT_FORMAT,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      appVersion: SNAPSHOT_APP_VERSION,
    }) + "\n"), { name: "format.json" });
    archive.file(databasePath, { name: "library.sqlite" });
    for (const pdf of pdfs) archive.file(pdf.path, { name: `pdfs/${pdf.id}.pdf`, store: true } as import("archiver").ZipEntryData);
    void archive.finalize().catch((error: unknown) => finish(error));
    return { stream: Readable.toWeb(archive) as ReadableStream<Uint8Array>, done };
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}

export async function receiveSnapshotUpload(request: Request, root: string, maxBytes: number): Promise<string> {
  const contentType = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || !request.body) throw snapshotError("SNAPSHOT_REQUIRED");
  const directory = await mkdtemp(join(snapshotRoot(root), ".snapshot-upload-"));
  const archivePath = join(directory, "snapshot.zip");
  const headers = Object.fromEntries(request.headers.entries()) as IncomingHttpHeaders;
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({ headers, limits: { files: 1, parts: 2, fileSize: normalizedLimit(maxBytes) } });
  } catch {
    await cleanupDirectory(directory);
    throw snapshotError("SNAPSHOT_REQUIRED");
  }
  let fileSeen = false;
  let fileError: Error | undefined;
  let writePromise: Promise<void> | undefined;
  const parsed = new Promise<void>((resolveParsed, rejectParsed) => {
    parser.on("file", (name, stream, info) => {
      if (name !== "backup" || fileSeen) {
        stream.resume();
        fileError = snapshotError("SNAPSHOT_FILE_INVALID");
        return;
      }
      fileSeen = true;
      stream.on("limit", () => { fileError = snapshotError("SNAPSHOT_TOO_LARGE"); });
      writePromise = pipeline(stream, createWriteStream(archivePath));
      void writePromise.catch((error) => { fileError = error instanceof Error ? error : snapshotError("SNAPSHOT_UPLOAD_FAILED"); });
      void info;
    });
    parser.on("field", () => { fileError = snapshotError("SNAPSHOT_FILE_INVALID"); });
    parser.once("filesLimit", () => { fileError = snapshotError("SNAPSHOT_FILE_INVALID"); });
    parser.once("fieldsLimit", () => { fileError = snapshotError("SNAPSHOT_FILE_INVALID"); });
    parser.once("partsLimit", () => { fileError = snapshotError("SNAPSHOT_FILE_INVALID"); });
    parser.once("error", (error) => rejectParsed(error));
    parser.once("close", () => resolveParsed());
  });
  const bodyStream = Readable.fromWeb(request.body as any);
  bodyStream.once("error", (error) => parser.destroy(error));
  bodyStream.pipe(parser);
  try {
    await parsed;
    if (writePromise) await writePromise;
    if (fileError) throw fileError;
    if (!fileSeen) throw snapshotError("SNAPSHOT_REQUIRED");
    return archivePath;
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}

async function validateSnapshotDatabase(databasePath: string): Promise<Database.Database> {
  let database: Database.Database;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    throw snapshotError("SNAPSHOT_DATABASE_INVALID");
  }
  try {
    const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity[0]?.integrity_check !== "ok") throw snapshotError("SNAPSHOT_DATABASE_INVALID");
    if ((database.pragma("foreign_key_check") as unknown[]).length) throw snapshotError("SNAPSHOT_DATABASE_INVALID");
    for (const [table, requiredColumns] of Object.entries(REQUIRED_SCHEMA)) {
      const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
      const actual = new Set(columns.map((column) => column.name));
      if (requiredColumns.some((column) => !actual.has(column))) throw snapshotError("SNAPSHOT_SCHEMA_INVALID");
    }
    const migrations = new Set((database.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((row) => row.name));
    if (REQUIRED_MIGRATIONS.some((name) => !migrations.has(name))) throw snapshotError("SNAPSHOT_SCHEMA_INVALID");
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error && error.message.startsWith("SNAPSHOT_")) throw error;
    throw snapshotError("SNAPSHOT_DATABASE_INVALID");
  }
}

export async function stageSnapshotRestore(archivePath: string, root: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<{ token: string }> {
  const destination = await mkdtemp(join(snapshotRoot(root), ".snapshot-restore-"));
  let database: Database.Database | undefined;
  const uploadDirectory = dirname(archivePath);
  const limit = normalizedLimit(maxBytes);
  const extraction: ExtractionState = { bytes: 0, maxBytes: limit };
  try {
    if (existsSync(pendingPath(root))) throw snapshotError("SNAPSHOT_RESTORE_PENDING");
    let archive: unzipper.CentralDirectory;
    try {
      archive = await unzipper.Open.file(archivePath);
    } catch {
      throw snapshotError("SNAPSHOT_REQUIRED");
    }
    const files = archive.files.filter((file) => file.type === "File");
    if (files.length !== archive.files.length) throw snapshotError("SNAPSHOT_ENTRY_INVALID");
    const paths = new Set<string>();
    let declaredBytes = 0;
    for (const file of files) {
      validateArchivePath(file.path);
      if (paths.has(file.path)) throw snapshotError("SNAPSHOT_DUPLICATE_ENTRY");
      paths.add(file.path);
      if (file.path !== "format.json" && file.path !== "library.sqlite" && !safePdfPath(file.path)) throw snapshotError("SNAPSHOT_ENTRY_INVALID");
      const entryStats = file as unknown as { uncompressedSize?: number; vars?: { uncompressedSize?: number } };
      const declaredSize = Number(entryStats.uncompressedSize ?? entryStats.vars?.uncompressedSize);
      if (Number.isFinite(declaredSize) && declaredSize >= 0) {
        declaredBytes += declaredSize;
        if (declaredBytes > limit) throw snapshotError("SNAPSHOT_TOO_LARGE");
      }
    }
    const formatEntry = archive.files.find((file) => file.path === "format.json" && file.type === "File");
    const databaseEntry = archive.files.find((file) => file.path === "library.sqlite" && file.type === "File");
    if (!formatEntry || !databaseEntry) throw snapshotError("SNAPSHOT_MANIFEST_REQUIRED");
    const formatStats = formatEntry as unknown as { uncompressedSize?: number; vars?: { uncompressedSize?: number } };
    const formatSize = formatStats.uncompressedSize ?? formatStats.vars?.uncompressedSize;
    if (formatSize !== undefined && formatSize > SNAPSHOT_MANIFEST_MAX_BYTES) throw snapshotError("SNAPSHOT_MANIFEST_TOO_LARGE");
    let format: { format?: unknown; formatVersion?: unknown; appVersion?: unknown };
    try {
      format = JSON.parse(await readArchiveEntry(formatEntry, extraction)) as { format?: unknown; formatVersion?: unknown; appVersion?: unknown };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("SNAPSHOT_")) throw error;
      throw snapshotError("SNAPSHOT_MANIFEST_INVALID");
    }
    if (format.format !== SNAPSHOT_FORMAT || format.formatVersion !== SNAPSHOT_FORMAT_VERSION || typeof format.appVersion !== "string" || !format.appVersion.trim()) throw snapshotError("SNAPSHOT_FORMAT_UNSUPPORTED");

    await mkdir(join(destination, "pdfs"), { recursive: true });
    await copyArchiveEntry(databaseEntry, join(destination, "library.sqlite"), extraction);
    for (const file of files) {
      if (!safePdfPath(file.path)) continue;
      await copyArchiveEntry(file, join(destination, file.path), extraction);
    }
    const databasePath = join(destination, "library.sqlite");
    database = await validateSnapshotDatabase(databasePath);
    const pdfIds = new Set(files.map((file) => safePdfPath(file.path)).filter((id): id is string => Boolean(id)));
    const referenceRows = database.prepare("SELECT id FROM papers WHERE r2_key IS NOT NULL").iterate() as Iterable<{ id: string }>;
    for (const row of referenceRows) {
      if (!pdfIds.has(row.id) || !existsSync(join(destination, "pdfs", `${row.id}.pdf`))) throw snapshotError("SNAPSHOT_PDF_MISSING");
    }
    const pdfRows = database.prepare("SELECT id FROM papers WHERE r2_key IS NOT NULL").all() as Array<{ id: string }>;
    if (pdfIds.size !== pdfRows.length || pdfRows.some((row) => !pdfIds.has(row.id))) throw snapshotError("SNAPSHOT_PDF_MISMATCH");
    database.close();
    database = undefined;

    const token = destination.split(/[\\/]/).pop() || "snapshot";
    const marker: PendingSnapshot = { token, directory: destination, createdAt: new Date().toISOString() };
    const markerTemp = `${pendingPath(root)}.${token}.tmp`;
    await writeFile(markerTemp, JSON.stringify(marker) + "\n", "utf8");
    renameSync(markerTemp, pendingPath(root));
    return { token };
  } catch (error) {
    database?.close();
    await cleanupDirectory(destination);
    throw error;
  } finally {
    if (isUploadDirectory(root, uploadDirectory)) await cleanupDirectory(uploadDirectory);
  }
}

export function applyPendingSnapshot(root: string): boolean {
  const markerFile = pendingPath(root);
  if (!existsSync(markerFile)) return false;
  const marker = readPendingSnapshot(root);
  const rootPath = snapshotRoot(root);
  const stagedDirectory = marker.directory;
  const stagedDatabase = join(stagedDirectory, "library.sqlite");
  const stagedPdfs = join(stagedDirectory, "pdfs");
  if (!existsSync(stagedDatabase) || !existsSync(stagedPdfs)) throw snapshotError("SNAPSHOT_RESTORE_INCOMPLETE");

  const liveDatabase = join(rootPath, "library.sqlite");
  const livePdfs = join(rootPath, "pdfs");
  const recoveryDirectory = join(rootPath, "trash", `snapshot-${marker.token}`);
  mkdirSync(recoveryDirectory, { recursive: true });
  const movedDatabase: string[] = [];
  let movedPdfs = false;
  try {
    for (const artifact of DATABASE_ARTIFACTS) {
      const liveArtifact = join(rootPath, artifact);
      if (existsSync(liveArtifact)) {
        renameSync(liveArtifact, join(recoveryDirectory, artifact));
        movedDatabase.push(artifact);
      }
    }
    if (existsSync(livePdfs)) { renameSync(livePdfs, join(recoveryDirectory, "pdfs")); movedPdfs = true; }
    renameSync(stagedDatabase, liveDatabase);
    renameSync(stagedPdfs, livePdfs);
    rmSync(stagedDirectory, { recursive: true, force: true });
    rmSync(markerFile, { force: true });
    return true;
  } catch (error) {
    for (const artifact of DATABASE_ARTIFACTS) rmSync(join(rootPath, artifact), { force: true });
    if (existsSync(livePdfs)) rmSync(livePdfs, { recursive: true, force: true });
    for (const artifact of movedDatabase) {
      if (existsSync(join(recoveryDirectory, artifact))) renameSync(join(recoveryDirectory, artifact), join(rootPath, artifact));
    }
    if (movedPdfs && existsSync(join(recoveryDirectory, "pdfs"))) renameSync(join(recoveryDirectory, "pdfs"), livePdfs);
    throw error;
  }
}
