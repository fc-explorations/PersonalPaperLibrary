import type { PaperRecord } from "../types.js";
import type { StoredQuestion, SummaryRecord } from "../repositories/analysis.js";

export const CLOUD_BACKUP_FORMAT = "personal-paper-library-cloud-backup";
export const CLOUD_BACKUP_VERSION = 1;
export const CLOUD_BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLOUD_BACKUP_MAX_PAPERS = 10_000;

export type CloudBackupPdf = {
  key: string;
  sizeBytes: number;
  sha256: string;
};

export type CloudBackupPaper = {
  paper: Omit<PaperRecord, "r2Key">;
  pdf?: CloudBackupPdf;
  summary?: SummaryRecord;
  questions: StoredQuestion[];
};

export type CloudBackupManifest = {
  format: typeof CLOUD_BACKUP_FORMAT;
  version: typeof CLOUD_BACKUP_VERSION;
  backupId: string;
  createdAt: string;
  expiresAt: string;
  papers: CloudBackupPaper[];
};

function backupIdValid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
}

function paperIdValid(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]+$/i.test(value);
}

function backupError(code: string): Error {
  return new Error(code);
}

export function createCloudBackupManifest(input: { backupId: string; createdAt: string; expiresAt: string; papers: CloudBackupPaper[] }): CloudBackupManifest {
  if (!backupIdValid(input.backupId)) throw backupError("BACKUP_ID_INVALID");
  if (input.papers.length > CLOUD_BACKUP_MAX_PAPERS) throw backupError("BACKUP_TOO_MANY_PAPERS");
  return {
    format: CLOUD_BACKUP_FORMAT,
    version: CLOUD_BACKUP_VERSION,
    backupId: input.backupId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    papers: input.papers,
  };
}

export function parseCloudBackupManifest(value: unknown, now = Date.now()): CloudBackupManifest {
  if (!value || typeof value !== "object") throw backupError("BACKUP_MANIFEST_INVALID");
  const record = value as Record<string, unknown>;
  if (record.format !== CLOUD_BACKUP_FORMAT || record.version !== CLOUD_BACKUP_VERSION) throw backupError("BACKUP_VERSION_UNSUPPORTED");
  if (!backupIdValid(record.backupId) || typeof record.createdAt !== "string" || typeof record.expiresAt !== "string") throw backupError("BACKUP_MANIFEST_INVALID");
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt)) throw backupError("BACKUP_MANIFEST_INVALID");
  if (expiresAt <= now) throw backupError("BACKUP_EXPIRED");
  if (!Array.isArray(record.papers) || record.papers.length > CLOUD_BACKUP_MAX_PAPERS) throw backupError("BACKUP_MANIFEST_INVALID");
  for (const entry of record.papers) {
    if (!entry || typeof entry !== "object") throw backupError("BACKUP_MANIFEST_INVALID");
    const paper = (entry as Record<string, unknown>).paper;
    if (!paper || typeof paper !== "object") throw backupError("BACKUP_MANIFEST_INVALID");
    const paperRecord = paper as Record<string, unknown>;
    if (!paperIdValid(paperRecord.id) || typeof paperRecord.title !== "string" || !Array.isArray((entry as Record<string, unknown>).questions)) throw backupError("BACKUP_MANIFEST_INVALID");
    const pdf = (entry as Record<string, unknown>).pdf;
    if (pdf !== undefined) {
      if (!pdf || typeof pdf !== "object") throw backupError("BACKUP_MANIFEST_INVALID");
      const pdfRecord = pdf as Record<string, unknown>;
      if (typeof pdfRecord.key !== "string" || typeof pdfRecord.sha256 !== "string" || !Number.isFinite(pdfRecord.sizeBytes)) throw backupError("BACKUP_MANIFEST_INVALID");
    }
  }
  return record as unknown as CloudBackupManifest;
}

export function backupPaperMetadata(paper: PaperRecord): Omit<PaperRecord, "r2Key"> {
  const { r2Key: _r2Key, ...metadata } = paper;
  return metadata;
}
