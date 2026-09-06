import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDatabase } from "./db/database.js";
import { PaperRepository } from "./repositories/papers.js";
import { FileStorage } from "./services/storage.js";

const storage = new FileStorage();
const db = openDatabase();
const repository = new PaperRepository(db);
await storage.cleanupStaging();
const papers = repository.list({ sort: "newest" });
const paperIds = new Set(papers.map((paper) => paper.id));
const storedIds = new Set(storage.listPdfIds());
const orphanedIds = [...storedIds].filter((id) => !paperIds.has(id));
const missingIds = papers.filter((paper) => paper.r2Key && !storedIds.has(paper.id)).map((paper) => paper.id);
if (orphanedIds.length) console.warn(`Storage audit: ${orphanedIds.length} PDF file(s) have no database record.`);
if (missingIds.length) console.warn(`Storage audit: ${missingIds.length} database record(s) reference a missing PDF.`);
const cleanupTimer = setInterval(() => { void storage.cleanupStaging(); }, 60 * 60 * 1000);
cleanupTimer.unref();

const hostname = process.env.HOST || "127.0.0.1";
if (!/^(127\.0\.0\.1|localhost|::1)$/.test(hostname) && !process.env.APP_PASSWORD) {
  throw new Error("APP_PASSWORD is required when HOST is not loopback.");
}

const app = createApp({ db, storage });
const server = serve({ fetch: app.fetch, hostname, port: Number(process.env.PORT || 3000) }, (info) => {
  console.log(`PersonalPaperLibrary running at http://${info.address}:${info.port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  server.close(() => {
    if (db.open) db.close();
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
