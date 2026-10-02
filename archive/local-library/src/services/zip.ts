import { createReadStream, statSync } from "node:fs";
import { Open } from "unzipper";

export interface ExtractedZipFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function extractPdfFiles(data: Uint8Array, maxPdfBytes: number): Promise<ExtractedZipFile[]> {
  let directory;
  try {
    directory = await Open.buffer(Buffer.from(data));
  } catch {
    throw new Error("ZIP_INVALID");
  }

  return directory.files
    .filter((entry) => entry.type === "File" && /\.pdf$/i.test(entry.path))
    .map((entry) => ({
      name: entry.path,
      size: entry.uncompressedSize,
      arrayBuffer: async () => {
        if (entry.uncompressedSize > maxPdfBytes) throw new Error("PDF_TOO_LARGE");
        const bytes = await entry.buffer();
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    }));
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function crc32Update(value: number, bytes: Uint8Array): number {
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

export function createZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = Buffer.from(file.data);
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30 + name.byteLength);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.byteLength, 18);
    localHeader.writeUInt32LE(data.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    name.forEach((byte, index) => localHeader.writeUInt8(byte, 30 + index));
    localParts.push(localHeader, data);

    const centralHeader = Buffer.alloc(46 + name.byteLength);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.byteLength, 20);
    centralHeader.writeUInt32LE(data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.forEach((byte, index) => centralHeader.writeUInt8(byte, 46 + index));
    centralParts.push(centralHeader);
    offset += localHeader.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function createZipStream(files: Array<{ name: string; path: string }>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (files.length > 0xffff) throw new Error("ZIP_TOO_MANY_FILES");
        const encoder = new TextEncoder();
        const centralParts: Buffer[] = [];
        let offset = 0;
        for (const file of files) {
          const name = encoder.encode(file.name);
          const stat = statSync(file.path);
          if (name.byteLength > 0xffff || stat.size > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP_TOO_LARGE");
          const localHeader = Buffer.alloc(30 + name.byteLength);
          localHeader.writeUInt32LE(0x04034b50, 0);
          localHeader.writeUInt16LE(20, 4);
          localHeader.writeUInt16LE(0x0808, 6);
          localHeader.writeUInt16LE(0, 8);
          localHeader.writeUInt16LE(name.byteLength, 26);
          name.forEach((byte, index) => localHeader.writeUInt8(byte, 30 + index));
          controller.enqueue(localHeader);

          let crc = 0xffffffff;
          let size = 0;
          for await (const chunk of createReadStream(file.path)) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            crc = crc32Update(crc, data);
            size += data.byteLength;
            controller.enqueue(data);
          }
          crc = (crc ^ 0xffffffff) >>> 0;
          const descriptor = Buffer.alloc(16);
          descriptor.writeUInt32LE(0x08074b50, 0);
          descriptor.writeUInt32LE(crc, 4);
          descriptor.writeUInt32LE(size, 8);
          descriptor.writeUInt32LE(size, 12);
          controller.enqueue(descriptor);

          const centralHeader = Buffer.alloc(46 + name.byteLength);
          centralHeader.writeUInt32LE(0x02014b50, 0);
          centralHeader.writeUInt16LE(20, 4);
          centralHeader.writeUInt16LE(20, 6);
          centralHeader.writeUInt16LE(0x0808, 8);
          centralHeader.writeUInt16LE(0, 10);
          centralHeader.writeUInt32LE(crc, 16);
          centralHeader.writeUInt32LE(size, 20);
          centralHeader.writeUInt32LE(size, 24);
          centralHeader.writeUInt16LE(name.byteLength, 28);
          centralHeader.writeUInt32LE(offset, 42);
          name.forEach((byte, index) => centralHeader.writeUInt8(byte, 46 + index));
          centralParts.push(centralHeader);
          offset += localHeader.byteLength + size + descriptor.byteLength;
        }

        const centralDirectory = Buffer.concat(centralParts);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(files.length, 8);
        end.writeUInt16LE(files.length, 10);
        end.writeUInt32LE(centralDirectory.byteLength, 12);
        end.writeUInt32LE(offset, 16);
        controller.enqueue(centralDirectory);
        controller.enqueue(end);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
