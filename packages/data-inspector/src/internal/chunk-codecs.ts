import { zstdDecompress } from "./zstd";

export class UnsupportedCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCodecError";
  }
}

export interface Codec {
  id: string;
  [key: string]: unknown;
}

function corrupt(what: string): Error {
  return new Error(`${what}: the compressed data is corrupt`);
}

function tooLarge(): Error {
  return new Error("the chunk decodes to more than its shape holds");
}

const CRC32C = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32c(src: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < src.length; i += 1) crc = CRC32C[(crc ^ src[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function lz4Block(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let ip = 0;
  let op = 0;
  const byte = (): number => {
    if (ip >= src.length) throw corrupt("lz4");
    return src[ip++];
  };
  const length = (start: number): number => {
    let total = start;
    if (start !== 15) return total;
    for (let b = 255; b === 255; ) {
      b = byte();
      total += b;
    }
    return total;
  };
  while (ip < src.length) {
    const token = byte();
    const literals = length(token >> 4);
    if (ip + literals > src.length || op + literals > size) throw corrupt("lz4");
    out.set(src.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;
    if (ip >= src.length) break;
    const offset = byte() | (byte() << 8);
    const match = length(token & 15) + 4;
    if (offset === 0 || offset > op || op + match > size) throw corrupt("lz4");
    for (let i = 0; i < match; i += 1, op += 1) out[op] = out[op - offset];
  }
  if (op !== size) throw corrupt("lz4");
  return out;
}

const BLOSCLZ_MAX_DISTANCE = 8191;

export function bloscLz(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let ip = 0;
  let op = 0;
  const byte = (): number => {
    if (ip >= src.length) throw corrupt("blosclz");
    return src[ip++];
  };
  let ctrl = byte() & 31;
  for (;;) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      if (len === 6) {
        for (let code = 255; code === 255; ) {
          code = byte();
          len += code;
        }
      }
      const code = byte();
      len += 3;
      let ref = op - ofs - code;
      if (code === 255 && ofs === 31 << 8) {
        ofs = byte() << 8;
        ofs += byte();
        ref = op - ofs - BLOSCLZ_MAX_DISTANCE;
      }
      ref -= 1;
      if (ref < 0 || op + len > size) throw corrupt("blosclz");
      for (let i = 0; i < len; i += 1, op += 1) out[op] = out[ref + i];
    } else {
      const literals = ctrl + 1;
      if (ip + literals > src.length || op + literals > size) throw corrupt("blosclz");
      out.set(src.subarray(ip, ip + literals), op);
      ip += literals;
      op += literals;
    }
    if (ip >= src.length) break;
    ctrl = byte();
  }
  if (op !== size) throw corrupt("blosclz");
  return out;
}

export async function inflate(
  src: Uint8Array,
  format: "deflate" | "gzip",
  limit: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new UnsupportedCodecError("this browser cannot decompress zlib or gzip");
  }
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  writer.write(new Uint8Array(src)).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function unshuffle(src: Uint8Array, typesize: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const elements = Math.floor(src.length / typesize);
  for (let j = 0; j < elements; j += 1) {
    for (let i = 0; i < typesize; i += 1) out[j * typesize + i] = src[i * elements + j];
  }
  const done = elements * typesize;
  out.set(src.subarray(done), done);
  return out;
}

async function bloscStream(code: number, src: Uint8Array, size: number): Promise<Uint8Array> {
  if (code === 0) return bloscLz(src, size);
  if (code === 1) return lz4Block(src, size);
  if (code === 3 || code === 4) {
    const out = code === 3 ? await inflate(src, "deflate", size) : zstdDecompress(src, size);
    if (out.length !== size) throw corrupt(`blosc ${code === 3 ? "zlib" : "zstd"}`);
    return out;
  }
  throw new UnsupportedCodecError(
    `blosc's ${["blosclz", "lz4", "snappy", "zlib", "zstd"][code] ?? `codec ${code}`} is not supported`,
  );
}

const YIELD_BYTES = 256 * 1024;

export async function pause(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, 0));
  if (signal?.aborted) throw new DOMException("The read was aborted.", "AbortError");
}

const BLOSC_MAX_SPLITS = 16;
const BLOSC_MIN_BUFFERSIZE = 128;

async function bloscBlock(
  src: Uint8Array,
  start: number,
  end: number,
  size: number,
  splits: number,
  code: number,
): Promise<Uint8Array> {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const each = Math.floor(size / splits);
  const out = new Uint8Array(size);
  let at = start;
  for (let s = 0; s < splits; s += 1) {
    if (at + 4 > end) throw corrupt("blosc");
    const length = view.getInt32(at, true);
    at += 4;
    if (length < 0 || at + length > end) throw corrupt("blosc");
    const stream = src.subarray(at, at + length);
    out.set(length === each ? stream : await bloscStream(code, stream, each), s * each);
    at += length;
  }
  return out;
}

export async function blosc(
  src: Uint8Array,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (src.length < 16) throw corrupt("blosc");
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const flags = src[2];
  const typesize = src[3];
  const nbytes = view.getUint32(4, true);
  const blocksize = view.getUint32(8, true);
  const cbytes = view.getUint32(12, true);
  if (cbytes > src.length || cbytes < 16) throw corrupt("blosc");
  if (nbytes > limit) throw tooLarge();
  if (flags & 0x02) {
    if (16 + nbytes > cbytes) throw corrupt("blosc");
    return src.slice(16, 16 + nbytes);
  }
  if (nbytes === 0) return new Uint8Array(0);
  if (blocksize === 0 || typesize === 0) throw corrupt("blosc");
  const code = (flags >> 5) & 0x07;
  const leftover = nbytes % blocksize;
  const blocks = Math.floor(nbytes / blocksize) + (leftover > 0 ? 1 : 0);
  const table = 16 + blocks * 4;
  if (table > cbytes) throw corrupt("blosc");
  const starts = Array.from({ length: blocks }, (_, j) => view.getUint32(16 + j * 4, true));
  const physical = [...new Set(starts)].sort((a, b) => a - b);
  const ends = new Map<number, number>();
  physical.forEach((start, i) => ends.set(start, physical[i + 1] ?? cbytes));
  let sinceYield = 0;
  const dontSplit = (flags & 0x10) !== 0;
  const out = new Uint8Array(nbytes);
  for (let j = 0; j < blocks; j += 1) {
    const last = j === blocks - 1 && leftover > 0;
    const size = last ? leftover : blocksize;
    const start = starts[j];
    if (start < table || start >= cbytes) throw corrupt("blosc");
    const end = ends.get(start)!;
    const shuffle = (flags & 0x01) !== 0 && typesize > 1;
    if ((flags & 0x04) !== 0 && size >= typesize) {
      throw new UnsupportedCodecError("blosc's bit shuffle is not supported");
    }
    const splits =
      !dontSplit &&
      typesize <= BLOSC_MAX_SPLITS &&
      Math.floor(size / typesize) >= BLOSC_MIN_BUFFERSIZE &&
      !last
        ? typesize
        : 1;
    const block = await bloscBlock(src, start, end, size, splits, code);
    out.set(shuffle ? unshuffle(block, typesize) : block, j * blocksize);
    sinceYield += size;
    if (sinceYield >= YIELD_BYTES) {
      sinceYield = 0;
      await pause(signal);
    }
  }
  return out;
}

export async function decodeBytes(
  src: Uint8Array,
  codec: Codec,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  await pause(signal);
  switch (codec.id) {
    case "blosc":
      return blosc(src, limit, signal);
    case "zlib":
      return inflate(src, "deflate", limit);
    case "gzip":
      return inflate(src, "gzip", limit);
    case "zstd":
      return zstdDecompress(src, limit);
    case "lz4": {
      if (src.length < 4) throw corrupt("lz4");
      const size = new DataView(src.buffer, src.byteOffset, src.byteLength).getUint32(0, true);
      if (size > limit) throw tooLarge();
      return lz4Block(src.subarray(4), size);
    }
    case "crc32c": {
      if (src.length < 4) throw corrupt("crc32c");
      const body = src.subarray(0, src.length - 4);
      const stored = new DataView(src.buffer, src.byteOffset, src.byteLength).getUint32(
        src.length - 4,
        true,
      );
      if (crc32c(body) !== stored) throw new Error("crc32c: the checksum does not match");
      return body;
    }
    default:
      throw new UnsupportedCodecError(`the ${codec.id} codec is not supported`);
  }
}
