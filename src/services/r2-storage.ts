export interface R2ObjectLike {
  key: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body?: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2ListResultLike {
  objects: R2ObjectLike[];
  truncated: boolean;
  cursor?: string;
}

export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | Blob | string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResultLike>;
}

export interface R2StorageMove {
  token: string;
  paperId: string;
  trashKey: string;
}

export interface R2StoredPdf {
  key: string;
  sha256: string;
  sizeBytes: number;
}

const PDF_CONTENT_TYPE = "application/pdf";
const STAGING_PREFIX = "staging/";
const PAPER_PREFIX = "papers/";
const TRASH_PREFIX = "trash/";

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertPaperId(paperId: string): void {
  if (!/^[a-z0-9_-]+$/i.test(paperId)) throw new Error("INVALID_PAPER_ID");
}

function assertToken(token: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(token)) throw new Error("INVALID_STAGING_TOKEN");
}

function asBytes(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/**
 * R2-backed PDF storage for the hosted runtime.
 *
 * Staged and trashed objects use separate prefixes because R2 has no atomic
 * rename. Promotion/recovery is therefore copy-then-delete and callers must
 * retain their database rollback path until the operation completes.
 */
export class R2Storage {
  constructor(private readonly bucket: R2BucketLike) {}

  async stage(bytes: Uint8Array): Promise<{ token: string; sizeBytes: number; sha256: string }> {
    const token = crypto.randomUUID();
    await this.bucket.put(this.stagingKey(token), bytes, { httpMetadata: { contentType: PDF_CONTENT_TYPE } });
    return { token, sizeBytes: bytes.byteLength, sha256: await sha256(bytes) };
  }

  async promoteStagedFile(token: string, paperId: string): Promise<R2StoredPdf> {
    assertToken(token);
    assertPaperId(paperId);
    const staged = await this.bucket.get(this.stagingKey(token));
    if (!staged) throw new Error("STAGED_FILE_NOT_FOUND");
    const bytes = asBytes(await staged.arrayBuffer());
    const key = this.paperKey(paperId);
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: PDF_CONTENT_TYPE } });
    await this.bucket.delete(this.stagingKey(token));
    return { key, sha256: await sha256(bytes), sizeBytes: bytes.byteLength };
  }

  async discardStagedFile(token: string): Promise<void> {
    assertToken(token);
    await this.bucket.delete(this.stagingKey(token));
  }

  async put(paperId: string, bytes: Uint8Array): Promise<R2StoredPdf> {
    assertPaperId(paperId);
    const key = this.paperKey(paperId);
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: PDF_CONTENT_TYPE } });
    return { key, sha256: await sha256(bytes), sizeBytes: bytes.byteLength };
  }

  async get(paperId: string): Promise<Uint8Array | null> {
    assertPaperId(paperId);
    const object = await this.getObject(paperId);
    return object ? asBytes(await object.arrayBuffer()) : null;
  }

  async getObject(paperId: string): Promise<R2ObjectBodyLike | null> {
    assertPaperId(paperId);
    return this.bucket.get(this.paperKey(paperId));
  }

  async delete(paperId: string): Promise<void> {
    assertPaperId(paperId);
    await this.bucket.delete(this.paperKey(paperId));
  }

  async moveToTrash(paperId: string): Promise<R2StorageMove | null> {
    assertPaperId(paperId);
    const source = await this.bucket.get(this.paperKey(paperId));
    if (!source) return null;
    const token = crypto.randomUUID();
    const trashKey = `${TRASH_PREFIX}${token}.pdf`;
    const bytes = asBytes(await source.arrayBuffer());
    await this.bucket.put(trashKey, bytes, { httpMetadata: { contentType: PDF_CONTENT_TYPE } });
    await this.bucket.delete(this.paperKey(paperId));
    return { token, paperId, trashKey };
  }

  async restoreFromTrash(move: R2StorageMove): Promise<void> {
    assertToken(move.token);
    assertPaperId(move.paperId);
    const source = await this.bucket.get(move.trashKey || `${TRASH_PREFIX}${move.token}.pdf`);
    if (!source) return;
    const bytes = asBytes(await source.arrayBuffer());
    await this.bucket.put(this.paperKey(move.paperId), bytes, { httpMetadata: { contentType: PDF_CONTENT_TYPE } });
  }

  async finalizeTrash(move: R2StorageMove): Promise<void> {
    assertToken(move.token);
    await this.bucket.delete(move.trashKey || `${TRASH_PREFIX}${move.token}.pdf`);
  }

  async cleanupStaging(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
    const cutoff = now - maxAgeMs;
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: STAGING_PREFIX, cursor, limit: 1_000 });
      keys.push(...page.objects.filter((object) => object.uploaded.getTime() < cutoff).map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (keys.length) await this.bucket.delete(keys);
    return keys.length;
  }

  paperKey(paperId: string): string {
    assertPaperId(paperId);
    return `${PAPER_PREFIX}${paperId}.pdf`;
  }

  stagingKey(token: string): string {
    assertToken(token);
    return `${STAGING_PREFIX}${token}.pdf`;
  }
}
