import { describe, expect, it } from "vitest";
import { R2Storage, type R2BucketLike, type R2ObjectBodyLike, type R2ObjectLike } from "../src/services/r2-storage.js";

class MemoryR2 implements R2BucketLike {
  readonly objects = new Map<string, { bytes: Uint8Array; uploaded: Date; contentType?: string }>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | Blob | string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike> {
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = new Uint8Array(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
    else throw new Error("TEST_STREAM_NOT_SUPPORTED");
    const uploaded = new Date();
    this.objects.set(key, { bytes, uploaded, contentType: options?.httpMetadata?.contentType });
    return this.metadata(key)!;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...this.metadata(key)!,
      arrayBuffer: async () => object.bytes.slice().buffer,
    };
  }

  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) this.objects.delete(item);
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.objects.keys()].filter((key) => !options.prefix || key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = options.limit || 1_000;
    const page = keys.slice(start, start + limit);
    const next = start + page.length < keys.length ? String(start + page.length) : undefined;
    return { objects: page.map((key) => this.metadata(key)!), truncated: Boolean(next), cursor: next };
  }

  private metadata(key: string): R2ObjectLike | undefined {
    const object = this.objects.get(key);
    return object ? { key, size: object.bytes.byteLength, uploaded: object.uploaded, httpMetadata: { contentType: object.contentType } } : undefined;
  }
}

const pdf = new TextEncoder().encode("%PDF-1.7\ncloud");

describe("R2Storage", () => {
  it("stages, promotes, reads, and discards PDF objects", async () => {
    const bucket = new MemoryR2();
    const storage = new R2Storage(bucket);
    const staged = await storage.stage(pdf);
    expect(bucket.objects.has(`staging/${staged.token}.pdf`)).toBe(true);

    const promoted = await storage.promoteStagedFile(staged.token, "paper-1");
    expect(promoted).toMatchObject({ key: "papers/paper-1.pdf", sizeBytes: pdf.byteLength });
    expect(bucket.objects.has(`staging/${staged.token}.pdf`)).toBe(false);
    expect(new Uint8Array((await storage.get("paper-1"))!)).toEqual(pdf);

    const abandoned = await storage.stage(pdf);
    await storage.discardStagedFile(abandoned.token);
    expect(bucket.objects.has(`staging/${abandoned.token}.pdf`)).toBe(false);
  });

  it("moves an object to recoverable trash and restores it", async () => {
    const bucket = new MemoryR2();
    const storage = new R2Storage(bucket);
    await storage.put("paper-1", pdf);
    const move = await storage.moveToTrash("paper-1");
    expect(move).not.toBeNull();
    expect(await storage.get("paper-1")).toBeNull();
    await storage.restoreFromTrash(move!);
    expect(new Uint8Array((await storage.get("paper-1"))!)).toEqual(pdf);
    await storage.finalizeTrash(move!);
    expect(bucket.objects.has(move!.trashKey)).toBe(false);
  });

  it("cleans only expired staged objects", async () => {
    const bucket = new MemoryR2();
    const storage = new R2Storage(bucket);
    const old = await storage.stage(pdf);
    const oldObject = bucket.objects.get(`staging/${old.token}.pdf`)!;
    oldObject.uploaded = new Date(0);
    const current = await storage.stage(pdf);

    expect(await storage.cleanupStaging(1_000, 10_000)).toBe(1);
    expect(bucket.objects.has(`staging/${old.token}.pdf`)).toBe(false);
    expect(bucket.objects.has(`staging/${current.token}.pdf`)).toBe(true);
  });
});
