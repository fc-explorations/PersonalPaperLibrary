import Database from "better-sqlite3";
import { resolve } from "node:path";
import { runMigrations } from "./migrate.js";

export function openDatabase(path = resolve("data/library.sqlite")) {
  const db = runMigrations(path);
  db.pragma("foreign_keys = ON");
  return db;
}
