import { decodeBytes, type Codec } from "./internal/chunk-codecs";
import { normalizeUrl, resolveAuthHeaders, type GetAuthHeaders } from "./internal/http";
import type { ZarrDataset, ZarrMetadataResult, ZarrVariable } from "./zarr-metadata";

export interface ChunkSource {
  path: string;
  chunkPrefix: string;
  dtype: string;
  littleEndian: boolean;
  codecs: Codec[];
  fill?: unknown;
}

export interface DecodedValues {
  dtype: string;
  preview: string;
  repr: string;
}

interface NumericType {
  kind: "i" | "u" | "f" | "M";
  size: number;
  unit?: string;
}

const UNIT_NS: Record<string, number> = {
  D: 86_400e9,
  h: 3_600e9,
  m: 60e9,
  s: 1e9,
  ms: 1e6,
  us: 1e3,
  ns: 1,
};

const CF_UNITS: Array<[RegExp, string]> = [
  [/^days?$/i, "D"],
  [/^(hours?|hrs?|h)$/i, "h"],
  [/^(minutes?|mins?)$/i, "m"],
  [/^(seconds?|secs?|s)$/i, "s"],
  [/^(milliseconds?|msecs?|ms)$/i, "ms"],
  [/^(microseconds?|usecs?|us)$/i, "us"],
  [/^(nanoseconds?|nsecs?|ns)$/i, "ns"],
];

const GREGORIAN = new Set(["standard", "gregorian", "proleptic_gregorian"]);
const MAX_CHUNK_BYTES = 1024 * 1024;

interface Constants {
  zero: bigint;
  billion: bigint;
  nat: bigint;
  max: bigint;
  gregorianStart: bigint;
}

let constants: Constants | null = null;

function big(): Constants {
  constants ??= {
    zero: BigInt(0),
    billion: BigInt(1e9),
    nat: -(BigInt(2) ** BigInt(63)),
    max: BigInt(2) ** BigInt(63) - BigInt(1),
    gregorianStart: BigInt(Date.UTC(1582, 9, 15)) * BigInt(1e6),
  };
  return constants;
}

export function bigIntAvailable(): boolean {
  return typeof BigInt === "function" && typeof DataView.prototype.getBigInt64 === "function";
}
const MAX_STAGE_BYTES = 2 * MAX_CHUNK_BYTES + 65_536;
const TIME_BUDGET_MS = 3_000;
const LINE_WIDTH = 75;

class Undecodable extends Error {}

export function numericType(dtype: string): NumericType | null {
  const named: Record<string, NumericType> = {
    int8: { kind: "i", size: 1 },
    int16: { kind: "i", size: 2 },
    int32: { kind: "i", size: 4 },
    int64: { kind: "i", size: 8 },
    uint8: { kind: "u", size: 1 },
    uint16: { kind: "u", size: 2 },
    uint32: { kind: "u", size: 4 },
    uint64: { kind: "u", size: 8 },
    float32: { kind: "f", size: 4 },
    float64: { kind: "f", size: 8 },
  };
  if (named[dtype]) return named[dtype];
  const match = /^[<>|=]?([iufM])(\d)(?:\[(\w+)\])?$/.exec(dtype);
  if (!match) return null;
  const kind = match[1] as NumericType["kind"];
  const size = Number(match[2]);
  if (kind === "M") {
    return size === 8 && match[3] && UNIT_NS[match[3]] ? { kind, size, unit: match[3] } : null;
  }
  if (kind === "f" && size !== 4 && size !== 8) return null;
  return [1, 2, 4, 8].includes(size) ? { kind, size } : null;
}

function inRange(ns: bigint): bigint {
  if (ns <= big().nat || ns > big().max) throw new Undecodable("outside datetime64[ns]");
  return ns;
}

function exactNs(value: bigint, unitNs: number): bigint {
  return value * BigInt(unitNs);
}

function floatNs(value: number, unitNs: number): bigint {
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return exactNs(BigInt(value), unitNs);
  }
  const ns = value * unitNs;
  if (!Number.isFinite(ns) || Math.abs(ns) >= 2 ** 80) {
    throw new Undecodable("outside datetime64[ns]");
  }
  return BigInt(Math.trunc(ns));
}

export function cfReference(units: string): { unitNs: number; origin: bigint } | null {
  const match = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units);
  if (!match) return null;
  const unit = CF_UNITS.find(([pattern]) => pattern.test(match[1]))?.[1];
  if (!unit) return null;
  const date =
    /^(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d{1,9})?)?)?\s*(?:Z|UTC|GMT|([+-])(\d{1,2}):?(\d{2})?)?$/i.exec(
      match[2],
    );
  if (!date) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", sign, oh = "0", om = "0"] = date;
  const day = new Date(Date.UTC(2000, 0, 1));
  day.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  day.setUTCHours(Number(h), Number(mi), Number(s), 0);
  const shift = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60) : 0;
  const fraction = frac ? BigInt(frac.slice(1).padEnd(9, "0")) : BigInt(0);
  const origin = BigInt(day.getTime()) * BigInt(1e6) - BigInt(shift) * big().billion + fraction;
  return { unitNs: UNIT_NS[unit], origin };
}

function pad(value: number | string, width: number): string {
  return String(value).padStart(width, "0");
}

function parts(stamp: bigint): { date: string; time: string; nanos: bigint; fraction: string } {
  const { billion, zero } = big();
  let sec = stamp / billion;
  let nanos = stamp - sec * billion;
  if (nanos < zero) {
    sec -= BigInt(1);
    nanos += billion;
  }
  const day = new Date(Number(sec) * 1000);
  const year = day.getUTCFullYear();
  const yyyy = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
  return {
    date: `${yyyy}-${pad(day.getUTCMonth() + 1, 2)}-${pad(day.getUTCDate(), 2)}`,
    time: `${pad(day.getUTCHours(), 2)}:${pad(day.getUTCMinutes(), 2)}:${pad(day.getUTCSeconds(), 2)}`,
    nanos,
    fraction: pad(nanos.toString(), 9),
  };
}

export function previewStamp(stamp: bigint | null): string {
  if (stamp === null) return "NaT";
  const { date, time, nanos, fraction } = parts(stamp);
  const sub =
    nanos === BigInt(0)
      ? ""
      : nanos % BigInt(1000) === BigInt(0)
        ? `.${fraction.slice(0, 6)}`
        : `.${fraction}`;
  return time === "00:00:00" && !sub ? date : `${date}T${time}${sub}`;
}

export function reprStamp(stamp: bigint | null): string {
  if (stamp === null) return "'NaT'";
  const { date, time, fraction } = parts(stamp);
  return `'${date}T${time}.${fraction}'`;
}

export function numpyRepr(words: readonly string[], total: number, summarized: boolean): string {
  const indent = " ".repeat(7);
  const lines: string[] = [];
  let line = indent;
  words.forEach((word, i) => {
    const last = i === words.length - 1;
    const width = LINE_WIDTH - 1;
    if (line.length > indent.length && line.length + word.length > width) {
      lines.push(line.replace(/\s+$/, ""));
      line = indent;
    }
    line += word;
    if (!last) line += ", ";
  });
  lines.push(line);
  const body = `array([${lines.join("\n").slice(indent.length)}]`;
  const extras = `${summarized ? `shape=(${total},), ` : ""}dtype='datetime64[ns]')`;
  const lastLine = body.length - (body.lastIndexOf("\n") + 1) + 1;
  return lastLine + 1 + extras.length > LINE_WIDTH
    ? `${body},\n${" ".repeat(6)}${extras}`
    : `${body}, ${extras}`;
}

export function decodedValues(
  stamps: ReadonlyArray<bigint | null>,
  total: number,
  summarized: boolean,
): DecodedValues {
  const head = summarized ? stamps.slice(0, 3) : stamps;
  const tail = summarized ? stamps.slice(-3) : [];
  const words = [...head.map(reprStamp), ...(summarized ? ["...", ...tail.map(reprStamp)] : [])];
  const first = stamps[0] ?? null;
  const last = stamps[stamps.length - 1] ?? null;
  const preview =
    stamps.length === 1
      ? previewStamp(first)
      : total === 2
        ? `${previewStamp(first)} ${previewStamp(last)}`
        : `${previewStamp(first)} ... ${previewStamp(last)}`;
  return { dtype: "datetime64[ns]", preview, repr: numpyRepr(words, total, summarized) };
}

type RawValue = { kind: "int"; value: bigint } | { kind: "float"; value: number };

function rawValue(view: DataView, index: number, type: NumericType, little: boolean): RawValue {
  const at = index * type.size;
  if (type.kind === "f") {
    return {
      kind: "float",
      value: type.size === 4 ? view.getFloat32(at, little) : view.getFloat64(at, little),
    };
  }
  if (type.size === 8) {
    return {
      kind: "int",
      value: type.kind === "u" ? view.getBigUint64(at, little) : view.getBigInt64(at, little),
    };
  }
  const read = (<Record<string, () => number>>{
    i1: () => view.getInt8(at),
    u1: () => view.getUint8(at),
    i2: () => view.getInt16(at, little),
    u2: () => view.getUint16(at, little),
    i4: () => view.getInt32(at, little),
    u4: () => view.getUint32(at, little),
  })[`${type.kind}${type.size}`];
  if (!read) throw new Undecodable("unsupported integer type");
  return { kind: "int", value: BigInt(read()) };
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Number.POSITIVE_INFINITY;
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  return null;
}

function fillValues(attrs: Record<string, unknown>, fill: unknown): number[] {
  return ([] as unknown[])
    .concat(attrs._FillValue, attrs.missing_value, fill)
    .map(numeric)
    .filter((value): value is number => value !== null);
}

function masked(raw: RawValue, fills: readonly number[], type: NumericType): boolean {
  return fills.some((fill) => {
    if (raw.kind === "int") return Number.isInteger(fill) && BigInt(fill) === raw.value;
    const stored = type.size === 4 ? Math.fround(fill) : fill;
    return stored === raw.value || (Number.isNaN(stored) && Number.isNaN(raw.value));
  });
}

export interface ReadOptions {
  getAuthHeaders?: GetAuthHeaders;
  signal?: AbortSignal;
}

async function readChunk(url: string, options: ReadOptions, cap: number): Promise<Uint8Array> {
  const headers = await resolveAuthHeaders(options.getAuthHeaders, url);
  const response = await fetch(url, {
    credentials: "same-origin",
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`the chunk answered ${response.status}`);
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        reader.cancel().catch(() => undefined);
        throw new Error("the chunk is larger than its shape allows");
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
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > cap) throw new Error("the chunk is larger than its shape allows");
  return new Uint8Array(buffer);
}

function stageLimits(raw: number, codecs: readonly Codec[]): { limits: number[]; cap: number } {
  const limits: number[] = [];
  let bound = raw;
  for (const codec of codecs) {
    limits.push(bound);
    bound =
      codec.id === "crc32c"
        ? bound + 4
        : Math.min(MAX_STAGE_BYTES, bound + Math.ceil(bound / 8) + 4096);
  }
  return { limits, cap: Math.min(MAX_STAGE_BYTES, bound) };
}

export async function readTimeValues(
  base: string,
  dv: ZarrVariable,
  source: ChunkSource,
  options: ReadOptions = {},
): Promise<DecodedValues | null> {
  const units = String(dv.attrs.units ?? "");
  const calendar = String(dv.attrs.calendar ?? "standard").toLowerCase();
  if (!GREGORIAN.has(calendar)) return null;
  const type = numericType(source.dtype);
  if (!type || dv.shape.length !== 1 || !bigIntAvailable()) return null;
  let unitNs: number;
  let origin = big().zero;
  if (type.kind === "M") {
    unitNs = UNIT_NS[type.unit!];
  } else {
    const reference = cfReference(units);
    if (!reference) return null;
    ({ unitNs, origin } = reference);
    if (calendar !== "proleptic_gregorian" && origin < big().gregorianStart) return null;
  }
  const scale = numeric(dv.attrs.scale_factor);
  const offset = numeric(dv.attrs.add_offset);
  const packed = type.kind !== "M" && (scale !== null || offset !== null);
  const total = dv.shape[0];
  const chunk = dv.chunks[0] || total;
  const rawBytes = chunk * type.size;
  if (total === 0 || rawBytes > MAX_CHUNK_BYTES) return null;
  const { limits, cap } = stageLimits(rawBytes, source.codecs);
  const all = total <= 6;
  const wanted = all
    ? Array.from({ length: total }, (_, i) => i)
    : [0, 1, 2, total - 3, total - 2, total - 1];
  const root = normalizeUrl(base).replace(/\/$/, "");
  const chunks = new Map<number, Promise<DataView>>();
  const load = (index: number): Promise<DataView> => {
    let pending = chunks.get(index);
    if (!pending) {
      pending = (async () => {
        let bytes = await readChunk(
          `${root}/${source.path}/${source.chunkPrefix}${index}`,
          options,
          cap,
        );
        for (let k = source.codecs.length - 1; k >= 0; k -= 1) {
          bytes = await decodeBytes(bytes, source.codecs[k], limits[k], options.signal);
        }
        const needed = Math.min(chunk, total - index * chunk) * type.size;
        if (bytes.length < needed || bytes.length > rawBytes) {
          throw new Error("the chunk does not match its shape");
        }
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      })();
      chunks.set(index, pending);
    }
    return pending;
  };
  const fills = type.kind === "M" ? [] : fillValues(dv.attrs, source.fill);
  if (
    type.kind !== "f" &&
    fills.some(
      (fill) => Number.isInteger(fill) && !Number.isSafeInteger(fill) && Math.abs(fill) < 2 ** 64,
    )
  ) {
    return null;
  }
  let stamps: Array<bigint | null>;
  try {
    stamps = await Promise.all(
      wanted.map(async (i) => {
        const view = await load(Math.floor(i / chunk));
        const raw = rawValue(view, i % chunk, type, source.littleEndian);
        if (type.kind === "M") {
          return raw.value === big().nat ? null : inRange(exactNs(raw.value as bigint, unitNs));
        }
        if (type.kind === "i" && type.size === 8 && raw.value === big().nat) return null;
        if (masked(raw, fills, type)) return null;
        if (raw.kind === "float" && Number.isNaN(raw.value)) return null;
        let ns: bigint;
        if (packed) {
          ns = floatNs(Number(raw.value) * (scale ?? 1) + (offset ?? 0), unitNs);
        } else if (raw.kind === "int") {
          ns = exactNs(raw.value, unitNs);
        } else {
          ns = floatNs(raw.value, unitNs);
        }
        return inRange(ns + origin);
      }),
    );
  } catch (error) {
    if (error instanceof Undecodable) return null;
    throw error;
  }
  if (
    calendar !== "proleptic_gregorian" &&
    stamps.some((s) => s !== null && s < big().gregorianStart)
  ) {
    return null;
  }
  return decodedValues(stamps, total, !all);
}

export async function readTimeCoordinates(
  base: string,
  result: ZarrMetadataResult,
  options: ReadOptions & { budgetMs?: number } = {},
): Promise<void> {
  if (!bigIntAvailable()) return;
  const outer = options.signal;
  const local = new AbortController();
  const stopped = new Promise<void>((done) => {
    if (local.signal.aborted) done();
    else local.signal.addEventListener("abort", () => done(), { once: true });
  });
  const stop = (): void => local.abort();
  outer?.addEventListener("abort", stop, { once: true });
  if (outer?.aborted) stop();
  const timer = setTimeout(stop, options.budgetMs ?? TIME_BUDGET_MS);
  const jobs: Array<Promise<void>> = [];
  try {
    if (!local.signal.aborted) {
      const datasets: ZarrDataset[] = result.groups ? Object.values(result.groups) : [result];
      for (const ds of datasets) {
        for (const dv of Object.values(ds.coords)) {
          const source = dv._chunks;
          if (!dv._isTimeCoord || !source) continue;
          jobs.push(
            Promise.resolve()
              .then(() => readTimeValues(base, dv, source, { ...options, signal: local.signal }))
              .then(
                (values) => {
                  if (values && !local.signal.aborted) dv._values = values;
                },
                () => undefined,
              ),
          );
        }
      }
    }
    await Promise.race([Promise.all(jobs), stopped]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
    local.abort();
  }
  if (outer?.aborted) {
    throw outer.reason instanceof Error
      ? outer.reason
      : new DOMException("The metadata read was aborted.", "AbortError");
  }
}
