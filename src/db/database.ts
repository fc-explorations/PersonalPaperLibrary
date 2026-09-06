import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function openDatabase(path = resolve(process.env.DATA_DIR || resolve(runtimeRoot, "data"), "library.sqlite")) {
  const db = runMigrations(path);
  db.pragma("foreign_keys = ON");
  return db;
}
