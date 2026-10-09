function corrupt(): Error {
  return new Error("zstd: the compressed data is corrupt");
}

const BLOCK_MAX = 128 * 1024;

function highBit(value: number): number {
  return 31 - Math.clz32(value);
}

class ForwardBits {
  private bit = 0;
  constructor(
    private readonly src: Uint8Array,
    private readonly start: number,
    private readonly end: number,
  ) {}
  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i += 1, this.bit += 1) {
      const at = this.start + (this.bit >> 3);
      if (at >= this.end) throw corrupt();
      value += ((this.src[at] >> (this.bit & 7)) & 1) * 2 ** i;
    }
    return value;
  }
  rewind(n: number): void {
    this.bit -= n;
  }
  bytesUsed(): number {
    return Math.ceil(this.bit / 8);
  }
}

class BackwardBits {
  remaining: number;
  constructor(
    private readonly src: Uint8Array,
    private readonly start: number,
    end: number,
  ) {
    if (end <= start) throw corrupt();
    const last = src[end - 1];
    if (last === 0) throw corrupt();
    this.remaining = (end - start - 1) * 8 + highBit(last);
  }
  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i += 1) {
      const pos = this.remaining - 1 - i;
      const bit = pos >= 0 ? (this.src[this.start + (pos >> 3)] >> (pos & 7)) & 1 : 0;
      value = value * 2 + bit;
    }
    this.remaining -= n;
    return value;
  }
}

interface FseTable {
  log: number;
  symbols: Uint8Array;
  bits: Uint8Array;
  base: Uint16Array;
}

function fseTable(counts: readonly number[], log: number): FseTable {
  const size = 1 << log;
  const symbols = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Array<number>(counts.length).fill(0);
  let high = size;
  counts.forEach((count, s) => {
    if (count === -1) {
      symbols[--high] = s;
      next[s] = 1;
    }
  });
  const step = (size >> 1) + (size >> 3) + 3;
  let pos = 0;
  counts.forEach((count, s) => {
    if (count <= 0) return;
    next[s] = count;
    for (let i = 0; i < count; i += 1) {
      symbols[pos] = s;
      do pos = (pos + step) & (size - 1);
      while (pos >= high);
    }
  });
  if (pos !== 0) throw corrupt();
  for (let i = 0; i < size; i += 1) {
    const state = next[symbols[i]]++;
    bits[i] = log - highBit(state);
    base[i] = (state << bits[i]) - size;
  }
  return { log, symbols, bits, base };
}

function rleTable(symbol: number): FseTable {
  return {
    log: 0,
    symbols: Uint8Array.of(symbol),
    bits: Uint8Array.of(0),
    base: Uint16Array.of(0),
  };
}

function readFseTable(
  src: Uint8Array,
  start: number,
  end: number,
  maxLog: number,
  maxSymbols: number,
): [FseTable, number] {
  const reader = new ForwardBits(src, start, end);
  const log = reader.read(4) + 5;
  if (log > maxLog) throw corrupt();
  let remaining = 1 << log;
  const counts: number[] = [];
  while (remaining > 0 && counts.length < maxSymbols) {
    const width = highBit(remaining + 1) + 1;
    let value = reader.read(width);
    const lower = (1 << (width - 1)) - 1;
    const threshold = (1 << width) - 1 - (remaining + 1);
    if ((value & lower) < threshold) {
      reader.rewind(1);
      value &= lower;
    } else if (value > lower) {
      value -= threshold;
    }
    const proba = value - 1;
    remaining -= Math.abs(proba);
    counts.push(proba);
    if (proba === 0) {
      for (let repeat = reader.read(2); ; repeat = reader.read(2)) {
        for (let i = 0; i < repeat && counts.length < maxSymbols; i += 1) counts.push(0);
        if (repeat !== 3) break;
      }
    }
  }
  if (remaining !== 0) throw corrupt();
  return [fseTable(counts, log), reader.bytesUsed()];
}

class FseState {
  state: number;
  constructor(
    private readonly table: FseTable,
    bits: BackwardBits,
  ) {
    this.state = bits.read(table.log);
  }
  symbol(): number {
    return this.table.symbols[this.state];
  }
  update(bits: BackwardBits): void {
    this.state = this.table.base[this.state] + bits.read(this.table.bits[this.state]);
  }
}

interface HuffmanTable {
  maxBits: number;
  symbols: Uint8Array;
  bits: Uint8Array;
}

function huffmanTable(weights: number[]): HuffmanTable {
  let total = 0;
  for (const w of weights) if (w > 0) total += 1 << (w - 1);
  if (total === 0) throw corrupt();
  const maxBits = highBit(total) + 1;
  const left = (1 << maxBits) - total;
  if (left & (left - 1)) throw corrupt();
  const all = [...weights, highBit(left) + 1];
  const size = 1 << maxBits;
  const symbols = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const lengths = all.map((w) => (w > 0 ? maxBits + 1 - w : 0));
  const rankCount = new Array<number>(maxBits + 2).fill(0);
  for (const length of lengths) rankCount[length] += 1;
  const rankIndex = new Array<number>(maxBits + 2).fill(0);
  rankIndex[maxBits] = 0;
  for (let i = maxBits; i >= 1; i -= 1) {
    rankIndex[i - 1] = rankIndex[i] + rankCount[i] * (1 << (maxBits - i));
    bits.fill(i, rankIndex[i], rankIndex[i - 1]);
  }
  lengths.forEach((length, s) => {
    if (length === 0) return;
    const span = 1 << (maxBits - length);
    symbols.fill(s, rankIndex[length], rankIndex[length] + span);
    rankIndex[length] += span;
  });
  return { maxBits, symbols, bits };
}

function readHuffmanTable(src: Uint8Array, start: number, limit: number): [HuffmanTable, number] {
  if (start >= limit) throw corrupt();
  const header = src[start];
  const weights: number[] = [];
  if (header >= 128) {
    const count = header - 127;
    if (start + 1 + Math.ceil(count / 2) > limit) throw corrupt();
    for (let i = 0; i < count; i += 1) {
      const byte = src[start + 1 + (i >> 1)];
      weights.push(i & 1 ? byte & 15 : byte >> 4);
    }
    return [huffmanTable(weights), 1 + Math.ceil(count / 2)];
  }
  const end = start + 1 + header;
  if (end > limit) throw corrupt();
  const [table, used] = readFseTable(src, start + 1, end, 6, 256);
  const bits = new BackwardBits(src, start + 1 + used, end);
  const one = new FseState(table, bits);
  const two = new FseState(table, bits);
  for (;;) {
    weights.push(one.symbol());
    one.update(bits);
    if (bits.remaining < 0) {
      weights.push(two.symbol());
      break;
    }
    weights.push(two.symbol());
    two.update(bits);
    if (bits.remaining < 0) {
      weights.push(one.symbol());
      break;
    }
    if (weights.length > 255) throw corrupt();
  }
  return [huffmanTable(weights), 1 + header];
}

function huffmanStream(
  table: HuffmanTable,
  src: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  at: number,
  count: number,
): void {
  const bits = new BackwardBits(src, start, end);
  const mask = (1 << table.maxBits) - 1;
  let state = bits.read(table.maxBits);
  for (let i = 0; i < count; i += 1) {
    out[at + i] = table.symbols[state];
    const n = table.bits[state];
    state = ((state << n) + bits.read(n)) & mask;
  }
  if (bits.remaining !== -table.maxBits) throw corrupt();
}

const LL_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128,
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
];
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
];
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const LL_DEFAULT = fseTable(
  [
    4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
    -1, -1, -1, -1,
  ],
  6,
);
const ML_DEFAULT = fseTable(
  [
    1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
  ],
  6,
);
const OF_DEFAULT = fseTable(
  [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1],
  5,
);

class Output {
  data: Uint8Array;
  length = 0;
  constructor(
    size: number,
    private readonly limit: number,
  ) {
    this.data = new Uint8Array(Math.min(Math.max(size, 1024), limit));
  }
  reserve(n: number): void {
    if (this.length + n > this.limit)
      throw new Error("zstd: the data decodes to more than allowed");
    if (this.length + n <= this.data.length) return;
    const grown = new Uint8Array(
      Math.min(Math.max(this.length + n, this.data.length * 2), this.limit),
    );
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }
  push(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }
  fill(byte: number, n: number): void {
    this.reserve(n);
    this.data.fill(byte, this.length, this.length + n);
    this.length += n;
  }
  match(offset: number, n: number, floor: number): void {
    if (offset <= 0 || offset > this.length - floor) throw corrupt();
    this.reserve(n);
    for (let i = 0; i < n; i += 1, this.length += 1) {
      this.data[this.length] = this.data[this.length - offset];
    }
  }
}

interface FrameState {
  huffman: HuffmanTable | null;
  ll: FseTable | null;
  of: FseTable | null;
  ml: FseTable | null;
  rep: [number, number, number];
}

function readLiterals(
  src: Uint8Array,
  start: number,
  limit: number,
  state: FrameState,
): [Uint8Array, number] {
  const byte = (i: number): number => {
    if (start + i >= limit) throw corrupt();
    return src[start + i];
  };
  const b0 = byte(0);
  const type = b0 & 3;
  const format = (b0 >> 2) & 3;
  if (type < 2) {
    let size: number;
    let header: number;
    if (format === 1) {
      size = (b0 >> 4) + (byte(1) << 4);
      header = 2;
    } else if (format === 3) {
      size = (b0 >> 4) + (byte(1) << 4) + (byte(2) << 12);
      header = 3;
    } else {
      size = b0 >> 3;
      header = 1;
    }
    if (size > BLOCK_MAX) throw corrupt();
    if (type === 0) {
      if (start + header + size > limit) throw corrupt();
      return [src.slice(start + header, start + header + size), header + size];
    }
    return [new Uint8Array(size).fill(byte(header)), header + 1];
  }
  let regenerated: number;
  let compressed: number;
  let header: number;
  const b1 = byte(1);
  const b2 = byte(2);
  if (format < 2) {
    regenerated = (b0 >> 4) | ((b1 & 0x3f) << 4);
    compressed = (b1 >> 6) | (b2 << 2);
    header = 3;
  } else if (format === 2) {
    const b3 = byte(3);
    regenerated = (b0 >> 4) | (b1 << 4) | ((b2 & 3) << 12);
    compressed = (b2 >> 2) | (b3 << 6);
    header = 4;
  } else {
    const b3 = byte(3);
    const b4 = byte(4);
    regenerated = (b0 >> 4) | (b1 << 4) | ((b2 & 0x3f) << 12);
    compressed = (b2 >> 6) | (b3 << 2) | (b4 << 10);
    header = 5;
  }
  let at = start + header;
  const end = at + compressed;
  if (end > limit) throw corrupt();
  if (type === 2) {
    const [table, used] = readHuffmanTable(src, at, end);
    state.huffman = table;
    at += used;
  }
  const table = state.huffman;
  if (!table) throw corrupt();
  if (regenerated > BLOCK_MAX) throw corrupt();
  const out = new Uint8Array(regenerated);
  if (format === 0) {
    huffmanStream(table, src, at, end, out, 0, regenerated);
  } else {
    if (at + 6 > end) throw corrupt();
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const sizes = [
      view.getUint16(at, true),
      view.getUint16(at + 2, true),
      view.getUint16(at + 4, true),
    ];
    at += 6;
    const each = Math.ceil(regenerated / 4);
    const counts = [each, each, each, regenerated - 3 * each];
    let from = at;
    for (let s = 0; s < 4; s += 1) {
      const to = s < 3 ? from + sizes[s] : end;
      if (to > end || counts[s] < 0) throw corrupt();
      huffmanStream(table, src, from, to, out, s * each, counts[s]);
      from = to;
    }
  }
  return [out, header + compressed];
}

function sequenceTable(
  mode: number,
  src: Uint8Array,
  at: number,
  end: number,
  fallback: FseTable,
  previous: FseTable | null,
  maxLog: number,
  maxSymbols: number,
): [FseTable, number] {
  if (mode === 0) return [fallback, 0];
  if (mode === 1) {
    if (at >= end) throw corrupt();
    return [rleTable(src[at]), 1];
  }
  if (mode === 2) return readFseTable(src, at, end, maxLog, maxSymbols);
  if (!previous) throw corrupt();
  return [previous, 0];
}

function compressedBlock(
  src: Uint8Array,
  start: number,
  end: number,
  out: Output,
  state: FrameState,
  floor: number,
): void {
  const [literals, used] = readLiterals(src, start, end, state);
  let at = start + used;
  const byte = (): number => {
    if (at >= end) throw corrupt();
    return src[at++];
  };
  let count = byte();
  if (count >= 128) {
    if (count === 255) {
      count = byte() + (byte() << 8) + 0x7f00;
    } else {
      count = ((count - 128) << 8) + byte();
    }
  }
  if (count === 0) {
    if (at !== end) throw corrupt();
    out.push(literals);
    return;
  }
  const modes = byte();
  if (modes & 3) throw corrupt();
  const [ll, llUsed] = sequenceTable(modes >> 6, src, at, end, LL_DEFAULT, state.ll, 9, 36);
  at += llUsed;
  const [of, ofUsed] = sequenceTable((modes >> 4) & 3, src, at, end, OF_DEFAULT, state.of, 8, 32);
  at += ofUsed;
  const [ml, mlUsed] = sequenceTable((modes >> 2) & 3, src, at, end, ML_DEFAULT, state.ml, 9, 53);
  at += mlUsed;
  state.ll = ll;
  state.of = of;
  state.ml = ml;
  const bits = new BackwardBits(src, at, end);
  const llState = new FseState(ll, bits);
  const ofState = new FseState(of, bits);
  const mlState = new FseState(ml, bits);
  const rep = state.rep;
  let lit = 0;
  for (let i = 0; i < count; i += 1) {
    const ofCode = ofState.symbol();
    const llCode = llState.symbol();
    const mlCode = mlState.symbol();
    if (llCode >= LL_BASE.length || mlCode >= ML_BASE.length || ofCode > 31) throw corrupt();
    const offsetValue = 2 ** ofCode + bits.read(ofCode);
    const matchLength = ML_BASE[mlCode] + bits.read(ML_BITS[mlCode]);
    const literalLength = LL_BASE[llCode] + bits.read(LL_BITS[llCode]);
    if (i < count - 1) {
      llState.update(bits);
      mlState.update(bits);
      ofState.update(bits);
    }
    let offset: number;
    if (offsetValue > 3) {
      offset = offsetValue - 3;
      rep[2] = rep[1];
      rep[1] = rep[0];
      rep[0] = offset;
    } else {
      let index = offsetValue - 1;
      if (literalLength === 0) index += 1;
      if (index === 0) {
        offset = rep[0];
      } else {
        offset = index < 3 ? rep[index] : rep[0] - 1;
        if (index > 1) rep[2] = rep[1];
        rep[1] = rep[0];
        rep[0] = offset;
      }
    }
    if (lit + literalLength > literals.length) throw corrupt();
    out.push(literals.subarray(lit, lit + literalLength));
    lit += literalLength;
    out.match(offset, matchLength, floor);
  }
  if (bits.remaining !== 0) throw corrupt();
  out.push(literals.subarray(lit));
}

interface XxhConstants {
  p1: bigint;
  p2: bigint;
  p3: bigint;
  p4: bigint;
  p5: bigint;
}

let xxh: XxhConstants | null = null;

function primes(): XxhConstants {
  xxh ??= {
    p1: BigInt("11400714785074694791"),
    p2: BigInt("14029467366897019727"),
    p3: BigInt("1609587929392839161"),
    p4: BigInt("9650029242287828579"),
    p5: BigInt("2870177450012600261"),
  };
  return xxh;
}

function u64(value: bigint): bigint {
  return BigInt.asUintN(64, value);
}

function rotl(value: bigint, bits: number): bigint {
  return u64((value << BigInt(bits)) | (value >> BigInt(64 - bits)));
}

function xxRound(acc: bigint, input: bigint): bigint {
  const XXH = primes();
  return u64(rotl(u64(acc + u64(input * XXH.p2)), 31) * XXH.p1);
}

function xxMerge(acc: bigint, value: bigint): bigint {
  const XXH = primes();
  return u64(u64((acc ^ xxRound(BigInt(0), value)) * XXH.p1) + XXH.p4);
}

export function xxhash64(data: Uint8Array): bigint {
  const XXH = primes();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.length;
  let at = 0;
  let hash: bigint;
  if (length >= 32) {
    let v1 = u64(XXH.p1 + XXH.p2);
    let v2 = XXH.p2;
    let v3 = BigInt(0);
    let v4 = u64(-XXH.p1);
    for (; at + 32 <= length; at += 32) {
      v1 = xxRound(v1, view.getBigUint64(at, true));
      v2 = xxRound(v2, view.getBigUint64(at + 8, true));
      v3 = xxRound(v3, view.getBigUint64(at + 16, true));
      v4 = xxRound(v4, view.getBigUint64(at + 24, true));
    }
    hash = u64(rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18));
    hash = xxMerge(hash, v1);
    hash = xxMerge(hash, v2);
    hash = xxMerge(hash, v3);
    hash = xxMerge(hash, v4);
  } else {
    hash = XXH.p5;
  }
  hash = u64(hash + BigInt(length));
  for (; at + 8 <= length; at += 8) {
    hash ^= xxRound(BigInt(0), view.getBigUint64(at, true));
    hash = u64(u64(rotl(hash, 27) * XXH.p1) + XXH.p4);
  }
  if (at + 4 <= length) {
    hash ^= u64(BigInt(view.getUint32(at, true)) * XXH.p1);
    hash = u64(u64(rotl(hash, 23) * XXH.p2) + XXH.p3);
    at += 4;
  }
  for (; at < length; at += 1) {
    hash ^= u64(BigInt(data[at]) * XXH.p5);
    hash = u64(rotl(hash, 11) * XXH.p1);
  }
  hash ^= hash >> BigInt(33);
  hash = u64(hash * XXH.p2);
  hash ^= hash >> BigInt(29);
  hash = u64(hash * XXH.p3);
  hash ^= hash >> BigInt(32);
  return hash;
}

export function zstdDecompress(src: Uint8Array, limit: number): Uint8Array {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const out = new Output(src.length * 4, limit);
  let at = 0;
  const need = (n: number): void => {
    if (at + n > src.length) throw corrupt();
  };
  while (at < src.length) {
    need(4);
    const magic = view.getUint32(at, true);
    at += 4;
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      need(4);
      const skip = view.getUint32(at, true);
      at += 4;
      need(skip);
      at += skip;
      continue;
    }
    if (magic !== 0xfd2fb528) throw corrupt();
    need(1);
    const descriptor = src[at++];
    const sizeFlag = descriptor >> 6;
    const single = (descriptor >> 5) & 1;
    const checksum = (descriptor >> 2) & 1;
    const dictFlag = descriptor & 3;
    if (descriptor & 0x08) throw corrupt();
    if (!single) {
      need(1);
      at += 1;
    }
    const dictBytes = [0, 1, 2, 4][dictFlag];
    need(dictBytes);
    let dictionary = 0;
    for (let i = 0; i < dictBytes; i += 1) dictionary += src[at + i] * 256 ** i;
    if (dictionary !== 0) throw corrupt();
    at += dictBytes;
    const sizeBytes = [single ? 1 : 0, 2, 4, 8][sizeFlag];
    need(sizeBytes);
    let contentSize: number | null = null;
    if (sizeBytes > 0) {
      contentSize = 0;
      for (let i = 0; i < sizeBytes; i += 1) contentSize += src[at + i] * 256 ** i;
      if (sizeBytes === 2) contentSize += 256;
      if (contentSize > limit) throw corrupt();
    }
    at += sizeBytes;
    const floor = out.length;
    const state: FrameState = { huffman: null, ll: null, of: null, ml: null, rep: [1, 4, 8] };
    for (let last = 0; !last; ) {
      need(3);
      const header = src[at] | (src[at + 1] << 8) | (src[at + 2] << 16);
      at += 3;
      last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      if (type === 0) {
        need(size);
        out.push(src.subarray(at, at + size));
        at += size;
      } else if (type === 1) {
        need(1);
        out.fill(src[at], size);
        at += 1;
      } else if (type === 2) {
        if (size > BLOCK_MAX) throw corrupt();
        need(size);
        compressedBlock(src, at, at + size, out, state, floor);
        at += size;
      } else {
        throw corrupt();
      }
    }
    if (contentSize !== null && out.length - floor !== contentSize) throw corrupt();
    if (checksum) {
      need(4);
      const expected = view.getUint32(at, true);
      const actual = Number(xxhash64(out.data.subarray(floor, out.length)) & BigInt(0xffffffff));
      if (expected !== actual) throw new Error("zstd: the content checksum does not match");
      at += 4;
    }
  }
  return out.data.slice(0, out.length);
}
