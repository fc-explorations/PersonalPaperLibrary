import busboy from "busboy";
import Database from "better-sqlite3";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingHttpHeaders } from "node:http";
import * as unzipper from "unzipper";
import type { FileStorage } from "./storage.js";

const require = createRequire(import.meta.url);
const archiver = require("archiver") as (format: string, options: { forceZip64: boolean; store: boolean }) => import("archiver").Archiver;

export const SNAPSHOT_FORMAT = "personal-paper-library-snapshot";
export const SNAPSHOT_FORMAT_VERSION = 1;
export const SNAPSHOT_APP_VERSION = "2.0.1";
export const SNAPSHOT_PENDING_FILE = "pending-snapshot-restore.json";

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

    const archive = archiver("zip", { forceZip64: true, store: true });
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
      createdAt: new Date().toISOString(),
    }) + "\n"), { name: "format.json" });
    archive.file(databasePath, { name: "library.sqlite" });
    for (const pdf of pdfs) archive.file(pdf.path, { name: `pdfs/${pdf.id}.pdf` });
    void archive.finalize().catch((error: unknown) => finish(error));
    return { stream: Readable.toWeb(archive) as ReadableStream<Uint8Array>, done: done.finally(() => cleanupDirectory(directory)) };
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
  const parser = busboy({ headers, limits: { files: 1, parts: 4, fileSize: maxBytes } });
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
    parser.on("field", (name, value) => { void name; void value; });
    parser.once("error", (error) => rejectParsed(error));
    parser.once("close", () => resolveParsed());
  });
  Readable.fromWeb(request.body as any).pipe(parser);
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
    const required = ["papers", "authors", "paper_authors", "tags", "paper_tags", "app_settings", "paper_summaries", "paper_questions", "paper_question_answers", "paper_search_index", "paper_search_fts"];
    const placeholders = required.map(() => "?").join(",");
    const rows = database.prepare(`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`).all(...required) as Array<{ name: string }>;
    if (new Set(rows.map((row) => row.name)).size !== required.length) throw snapshotError("SNAPSHOT_SCHEMA_INVALID");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function stageSnapshotRestore(archivePath: string, root: string): Promise<{ token: string }> {
  const destination = await mkdtemp(join(snapshotRoot(root), ".snapshot-restore-"));
  let database: Database.Database | undefined;
  try {
    if (existsSync(pendingPath(root))) throw snapshotError("SNAPSHOT_RESTORE_PENDING");
    const archive = await unzipper.Open.file(archivePath);
    const files = archive.files.filter((file) => file.type === "File");
    const paths = new Set<string>();
    for (const file of files) {
      validateArchivePath(file.path);
      if (paths.has(file.path)) throw snapshotError("SNAPSHOT_DUPLICATE_ENTRY");
      paths.add(file.path);
      if (file.path !== "format.json" && file.path !== "library.sqlite" && !safePdfPath(file.path)) throw snapshotError("SNAPSHOT_ENTRY_INVALID");
    }
    const formatEntry = archive.files.find((file) => file.path === "format.json" && file.type === "File");
    const databaseEntry = archive.files.find((file) => file.path === "library.sqlite" && file.type === "File");
    if (!formatEntry || !databaseEntry) throw snapshotError("SNAPSHOT_MANIFEST_REQUIRED");
    const formatSize = (formatEntry as unknown as { vars?: { uncompressedSize?: number } }).vars?.uncompressedSize;
    if (formatSize !== undefined && formatSize > 1024 * 1024) throw snapshotError("SNAPSHOT_MANIFEST_TOO_LARGE");
    const format = JSON.parse((await formatEntry.buffer()).toString("utf8")) as { format?: string; formatVersion?: number };
    if (format.format !== SNAPSHOT_FORMAT || format.formatVersion !== SNAPSHOT_FORMAT_VERSION) throw snapshotError("SNAPSHOT_FORMAT_UNSUPPORTED");

    await mkdir(join(destination, "pdfs"), { recursive: true });
    await pipeline(databaseEntry.stream(), createWriteStream(join(destination, "library.sqlite")));
    for (const file of files) {
      if (!safePdfPath(file.path)) continue;
      await pipeline(file.stream(), createWriteStream(join(destination, file.path)));
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
    await cleanupDirectory(dirname(archivePath));
  }
}

export function applyPendingSnapshot(root: string): boolean {
  const markerFile = pendingPath(root);
  if (!existsSync(markerFile)) return false;
  const marker = JSON.parse(readFileSync(markerFile, "utf8")) as PendingSnapshot;
  const rootPath = snapshotRoot(root);
  const stagedDirectory = resolve(marker.directory);
  if (!stagedDirectory.startsWith(`${rootPath}/.snapshot-restore-`)) throw snapshotError("SNAPSHOT_RESTORE_PATH_INVALID");
  const stagedDatabase = join(stagedDirectory, "library.sqlite");
  const stagedPdfs = join(stagedDirectory, "pdfs");
  if (!existsSync(stagedDatabase) || !existsSync(stagedPdfs)) throw snapshotError("SNAPSHOT_RESTORE_INCOMPLETE");

  const liveDatabase = join(rootPath, "library.sqlite");
  const livePdfs = join(rootPath, "pdfs");
  const recoveryDirectory = join(rootPath, "trash", `snapshot-${marker.token}`);
  mkdirSync(recoveryDirectory, { recursive: true });
  let movedDatabase = false;
  let movedPdfs = false;
  try {
    if (existsSync(liveDatabase)) { renameSync(liveDatabase, join(recoveryDirectory, "library.sqlite")); movedDatabase = true; }
    if (existsSync(livePdfs)) { renameSync(livePdfs, join(recoveryDirectory, "pdfs")); movedPdfs = true; }
    renameSync(stagedDatabase, liveDatabase);
    renameSync(stagedPdfs, livePdfs);
    rmSync(stagedDirectory, { recursive: true, force: true });
    rmSync(markerFile, { force: true });
    return true;
  } catch (error) {
    if (existsSync(liveDatabase)) rmSync(liveDatabase, { force: true });
    if (existsSync(livePdfs)) rmSync(livePdfs, { recursive: true, force: true });
    if (movedDatabase && existsSync(join(recoveryDirectory, "library.sqlite"))) renameSync(join(recoveryDirectory, "library.sqlite"), liveDatabase);
    if (movedPdfs && existsSync(join(recoveryDirectory, "pdfs"))) renameSync(join(recoveryDirectory, "pdfs"), livePdfs);
    throw error;
  }
}
