/**
 * A minimal, deterministic ZIP reader and writer. Here because the wheelhouse command has to build
 * a wheel from the PACKED npm package on a machine that has Node and nothing else: a wheel is a
 * ZIP and there is no ZIP in Node's standard library. DETERMINISTIC shapes it - a fixed timestamp
 * and fixed attributes per entry, entries written in the order given, a fixed compression level -
 * so building twice gives the same bytes and the same SHA-256. Scope: stored and deflated entries,
 * no encryption, no ZIP64; wheels are neither encrypted nor over 4 GB.
 */
// `deflateRawSync` is deliberately not imported: writing is STORED. See `writeZip`.
import { inflateRawSync } from "node:zlib";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** CRC-32, table-built once. The ZIP format wants it and nothing in Node exposes one. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Read a ZIP into `[{ name, data }]`, in central-directory order. The central directory is the
 * authority on what is in an archive - the local headers are a convenience a writer may leave
 * incomplete - so entries are enumerated from it and the local header is read only to find where
 * each entry's bytes start.
 */
export function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive: no end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error(`corrupt ZIP: central directory entry ${i} has the wrong signature`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`corrupt ZIP: ${name} does not start with a local file header`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else
      throw new Error(`${name} uses compression method ${method}, which this reader does not do`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Write `[{ name, data }]` as a ZIP, byte-identically for identical input - on EVERY machine.
 *
 * The fixed DOS timestamp is 1 January 2026, 00:00, matching what the previous Python builder
 * stamped: a wheel whose bytes changed with the build date could not be pinned by digest.
 *
 * ENTRIES ARE STORED, NOT DEFLATED. `deflateRawSync(data, { level: 9 })` is deterministic for a
 * given zlib and NOT across zlib builds, and Node bundles its own: identical input under Node 22
 * (zlib 1.3.1) and Node 23 produces different bytes, so a clean checkout reports "The derived
 * wheel does not match its recorded digest" with nothing wrong. Storing makes the bytes a pure
 * function of the names, contents and these fixed headers; it costs 46 KB to 182 KB for the
 * freva-client wheel in an artifact of about 39 MB, and a stored zip gzips (~38 KB) better than a
 * deflated one. `zipfile`, `pip` and Pyodide all read method 0.
 */
export function writeZip(entries) {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, "utf8");
    // Stored: the "compressed" bytes ARE the data. See the header.
    const compressed = data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CENTRAL_SIG, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10); // stored
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(0o644 << 16, 38); // external attributes: rw-r--r--
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, eocd]);
}
