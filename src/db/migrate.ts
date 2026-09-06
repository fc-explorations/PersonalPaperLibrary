import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function runMigrations(databasePath = resolve("data/library.sqlite")) {
  mkdirSync(join(databasePath, ".."), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const migrationDir = resolve("migrations");
  if (existsSync(migrationDir)) {
    const applied = new Set(
      (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((row) => row.name),
    );
    for (const name of readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort()) {
      if (applied.has(name)) continue;
      const sql = readFileSync(join(migrationDir, name), "utf8");
      db.transaction(() => {
        db.exec(sql);
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      })();
    }
  }
  return db;
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const db = runMigrations();
  db.close();
  console.log("Database migrations applied.");
}
