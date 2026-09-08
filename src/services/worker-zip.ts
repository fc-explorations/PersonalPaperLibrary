export interface WorkerZipFile {
  name: string;
  bytes: Uint8Array;
}

const ZIP_CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  ZIP_CRC_TABLE[index] = value >>> 0;
}

function zipCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = ZIP_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

/** Creates a small, store-only ZIP archive without Node.js dependencies. */
export function createWorkerZip(files: WorkerZipFile[]): Uint8Array {
  if (files.length > 0xffff) throw new Error("ZIP_TOO_MANY_FILES");
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.bytes;
    const crc = zipCrc32(data);
    if (name.byteLength > 0xffff || data.byteLength > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP_TOO_LARGE");
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true); localView.setUint32(14, crc, true); localView.setUint32(18, data.byteLength, true); localView.setUint32(22, data.byteLength, true); localView.setUint16(26, name.byteLength, true); local.set(name, 30);
    locals.push(local, data);
    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true); centralView.setUint16(8, 0x0800, true); centralView.setUint32(16, crc, true); centralView.setUint32(20, data.byteLength, true); centralView.setUint32(24, data.byteLength, true); centralView.setUint16(28, name.byteLength, true); centralView.setUint32(42, offset, true); central.set(name, 46);
    centrals.push(central); offset += local.byteLength + data.byteLength;
  }
  const central = concatBytes(centrals);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true); endView.setUint32(12, central.byteLength, true); endView.setUint32(16, offset, true);
  return concatBytes([...locals, central, end]);
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
