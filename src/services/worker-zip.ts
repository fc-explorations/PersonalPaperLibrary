export interface WorkerZipFile {
  name: string;
  bytes: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function read16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function read32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const DecompressionStreamConstructor = (globalThis as unknown as {
    DecompressionStream?: new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  }).DecompressionStream;
  if (!DecompressionStreamConstructor) throw new Error("ZIP_DECOMPRESSION_UNAVAILABLE");
  try {
    const stream = new DecompressionStreamConstructor("deflate-raw");
    const writer = stream.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } catch {
    throw new Error("ZIP_DECOMPRESSION_FAILED");
  }
}

function endOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (read32(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP_INVALID");
}

/** Extracts PDF entries from a standard ZIP archive in the Worker runtime. */
export async function extractWorkerPdfFiles(bytes: Uint8Array, maxPdfBytes: number): Promise<WorkerZipFile[]> {
  const eocd = endOfCentralDirectory(bytes);
  const entries = read16(bytes, eocd + 10);
  const centralSize = read32(bytes, eocd + 12);
  const centralOffset = read32(bytes, eocd + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP_UNSUPPORTED");
  if (centralOffset + centralSize > bytes.length) throw new Error("ZIP_INVALID");

  const decoder = new TextDecoder();
  const files: WorkerZipFile[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || read32(bytes, offset) !== CENTRAL_SIGNATURE) throw new Error("ZIP_INVALID");
    const flags = read16(bytes, offset + 8);
    const method = read16(bytes, offset + 10);
    const compressedSize = read32(bytes, offset + 20);
    const uncompressedSize = read32(bytes, offset + 24);
    const nameLength = read16(bytes, offset + 28);
    const extraLength = read16(bytes, offset + 30);
    const commentLength = read16(bytes, offset + 32);
    const localOffset = read32(bytes, offset + 42);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.pdf$/i.test(name) || name.endsWith("/")) continue;
    if (flags & 0x1) throw new Error("ZIP_ENCRYPTED");
    if (uncompressedSize > maxPdfBytes) throw new Error("PDF_TOO_LARGE");
    if (localOffset + 30 > bytes.length || read32(bytes, localOffset) !== LOCAL_SIGNATURE) throw new Error("ZIP_INVALID");
    const localNameLength = read16(bytes, localOffset + 26);
    const localExtraLength = read16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error("ZIP_INVALID");
    const compressed = bytes.slice(dataStart, dataEnd);
    const content = method === 0 ? compressed : method === 8 ? await inflateRaw(compressed) : (() => { throw new Error("ZIP_COMPRESSION_UNSUPPORTED"); })();
    if (content.byteLength !== uncompressedSize) throw new Error("ZIP_INVALID");
    files.push({ name, bytes: content });
  }
  return files;
}
