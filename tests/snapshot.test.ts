import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileStorage } from "../src/services/storage.js";
import { createSnapshotArchive, SNAPSHOT_FORMAT, SNAPSHOT_FORMAT_VERSION, stageSnapshotRestore } from "../src/services/snapshot.js";
import { createZip } from "../src/services/zip.js";

function makeDatabase(root: string): Database.Database {
  const db = new Database(join(root, "library.sqlite"));
  db.exec(`CREATE TABLE papers (id TEXT PRIMARY KEY, r2_key TEXT, title TEXT NOT NULL, metadata_source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE authors (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
    CREATE TABLE paper_authors (paper_id TEXT NOT NULL, author_id TEXT NOT NULL, author_order INTEGER NOT NULL);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE paper_tags (paper_id TEXT NOT NULL, tag_id TEXT NOT NULL);
    CREATE TABLE app_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE paper_summaries (paper_id TEXT PRIMARY KEY, content TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, generated_at TEXT NOT NULL, source_pdf_sha256 TEXT, prompt_version TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE paper_questions (paper_id TEXT NOT NULL, question_id TEXT NOT NULL, group_id TEXT NOT NULL, group_title TEXT NOT NULL, group_description TEXT NOT NULL, question_order INTEGER NOT NULL, label TEXT NOT NULL, prompt TEXT NOT NULL, definition_hash TEXT NOT NULL, is_custom INTEGER NOT NULL, is_active INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE paper_question_answers (paper_id TEXT NOT NULL, question_id TEXT NOT NULL, content TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, generated_at TEXT NOT NULL, source_pdf_sha256 TEXT, prompt_version TEXT NOT NULL, question_definition_hash TEXT, status TEXT NOT NULL, error_message TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE paper_search_index (paper_id TEXT PRIMARY KEY, search_text TEXT NOT NULL, content_hash TEXT NOT NULL, embedding_json TEXT, embedding_provider TEXT, embedding_model TEXT, status TEXT NOT NULL, error_message TEXT, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE paper_search_fts USING fts5(paper_id UNINDEXED, content);`);
  return db;
}

describe("snapshot backups", () => {
  it("streams a ZIP64 snapshot for a 20,000-paper library", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshot-scale-"));
    const db = makeDatabase(root);
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT INTO papers (id, title, metadata_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    db.transaction(() => { for (let index = 0; index < 20_000; index += 1) insert.run(`paper-${index}`, `Paper ${index}`, "manual", now, now); })();
    const storage = new FileStorage(root);
    const snapshot = await createSnapshotArchive(db, storage);
    const bytes = Buffer.from(await new Response(snapshot.stream).arrayBuffer());
    await snapshot.done;
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    expect(bytes.includes(Buffer.from(JSON.stringify({ format: SNAPSHOT_FORMAT, formatVersion: SNAPSHOT_FORMAT_VERSION })))).toBe(false);
    expect(bytes.length).toBeLessThan(4 * 1024 * 1024);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects unsafe archive paths before staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "snapshot-path-"));
    const archivePath = join(root, "unsafe.zip");
    writeFileSync(archivePath, createZip([{ name: "../outside", data: new Uint8Array([1]) }]));
    await expect(stageSnapshotRestore(archivePath, root)).rejects.toThrow("SNAPSHOT_PATH_INVALID");
    rmSync(root, { recursive: true, force: true });
  });
});
