// A look at an .xlsx file's zip before SheetJS opens it (phase5-spec.md §3.2).
// An .xlsx is a zip; a forged one can claim gigabytes of XML in a few
// kilobytes and exhaust the function's memory while being inflated.
//
// SheetJS (0.20.3, pure-JS inflate) finds the end record by scanning back from
// the last four bytes, walks the central directory, then inflates from each
// LOCAL header with the local sizes, reading the deflate stream until it ends
// rather than stopping at the compressed size; the sizes are only compared
// after inflating. So this guard parses the zip exactly as SheetJS does, and
// inflates every deflated entry itself with a hard output cap (native zlib,
// bounded by the declared size) before SheetJS is allowed near it.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CD_SIG = 0x02014b50;
const CD_SIZE = 46;
const LOCAL_SIG = 0x04034b50;
const LOCAL_SIZE = 30;
const ZIP64_EXTRA = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x08;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_UNCOMPRESSED = 200 * 1024 * 1024;
/** Entries larger than this are checked for their compression ratio. */
const RATIO_CHECK_BYTES = 1024 * 1024;
export const MAX_ZIP_RATIO = 200;

export const CFB_MESSAGE = "This spreadsheet is password-protected or in the old .xls format. Save it as .xlsx and upload it again.";
const NOT_XLSX = "This spreadsheet couldn't be opened: it isn't a valid .xlsx file. Check that it opens, then upload it again.";
const TOO_BIG = "This spreadsheet is too large to read safely. Split it into smaller files and upload them again.";

export type ZipCheck = { ok: true } | { ok: false; reason: "cfb" | "not_zip" | "zip64" | "entries" | "size" | "ratio"; message: string };

/** Whether an extra-field block holds a ZIP64 record, walked the way SheetJS walks it. */
function hasZip64Extra(view: DataView, start: number, length: number): boolean {
  let at = start;
  const end = start + length;
  while (at <= end - 4) {
    if (view.getUint16(at, true) === ZIP64_EXTRA) return true;
    at += 4 + view.getUint16(at + 2, true);
  }
  return false;
}

/** Whether the bytes are a zip SheetJS may safely open. */
export function checkXlsxZip(bytes: Uint8Array): ZipCheck {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return { ok: false, reason: "cfb", message: CFB_MESSAGE };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const notZip: ZipCheck = { ok: false, reason: "not_zip", message: NOT_XLSX };
  const tooBig = (reason: "zip64" | "entries" | "size" | "ratio"): ZipCheck => ({ ok: false, reason, message: TOO_BIG });

  // The end record SheetJS uses: the last signature in the file, found from length-4.
  let eocd = -1;
  for (let at = bytes.length - 4; at >= 0; at--) {
    if (u32(at) === EOCD_SIG) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0 || eocd + EOCD_SIZE > bytes.length) return notZip;
  // A second end record near the end means two readers could disagree on the directory.
  for (let at = eocd - 1; at >= Math.max(0, bytes.length - EOCD_SIZE - 0xffff); at--) {
    if (u32(at) === EOCD_SIG) return notZip;
  }
  if (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR_SIG) return tooBig("zip64");
  // SheetJS counts entries from the "this disk" field; both counts must agree.
  const entries = u16(eocd + 8);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (entries === 0xffff || u16(eocd + 10) === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return tooBig("zip64");
  if (entries !== u16(eocd + 10)) return notZip;
  if (entries > MAX_ZIP_ENTRIES) return tooBig("entries");
  if (cdOffset + cdSize > eocd) return notZip;

  // First the directory alone, so the totals are known before anything is inflated.
  type Entry = { compressed: number; uncompressed: number; local: number };
  const listed: Entry[] = [];
  let at = cdOffset;
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (at + CD_SIZE > eocd || u32(at) !== CD_SIG) return notZip;
    const compressed = u32(at + 20);
    const uncompressed = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const local = u32(at + 42);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff) return tooBig("zip64");
    if (at + CD_SIZE + nameLength + extraLength > eocd) return notZip;
    if (hasZip64Extra(view, at + CD_SIZE + nameLength, extraLength)) return tooBig("zip64");
    total += uncompressed;
    if (total > MAX_ZIP_UNCOMPRESSED) return tooBig("size");
    if (uncompressed > RATIO_CHECK_BYTES && (compressed === 0 || uncompressed / compressed > MAX_ZIP_RATIO)) return tooBig("ratio");
    listed.push({ compressed, uncompressed, local });
    at += CD_SIZE + nameLength + extraLength + u16(at + 32);
  }

  // Then each local header, which is what SheetJS inflates from: it must agree with the directory.
  for (const { compressed, uncompressed, local } of listed) {
    if (local + LOCAL_SIZE > bytes.length || u32(local) !== LOCAL_SIG) return notZip;
    const flags = u16(local + 6);
    const method = u16(local + 8);
    const localCompressed = u32(local + 18);
    const localUncompressed = u32(local + 22);
    const localName = u16(local + 26);
    const localExtra = u16(local + 28);
    const dataStart = local + LOCAL_SIZE + localName + localExtra;
    if (dataStart > bytes.length) return notZip;
    if (hasZip64Extra(view, local + LOCAL_SIZE + localName, localExtra)) return tooBig("zip64");
    // A data-descriptor entry may leave its local sizes at zero (SheetJS then
    // inflates until the stream ends, which is checked below); otherwise they
    // must match the directory.
    const deferred = (flags & FLAG_DATA_DESCRIPTOR) !== 0 && localCompressed === 0 && localUncompressed === 0;
    if (!deferred && (localCompressed !== compressed || localUncompressed !== uncompressed)) return notZip;
    if (method === METHOD_DEFLATE) {
      // SheetJS's inflate writes until the stream ends, past the declared size if
      // the stream says so. Inflate it here under a cap: the stream must end
      // within its compressed bytes and produce exactly the declared size.
      if (compressed === 0 || dataStart + compressed > bytes.length) return notZip;
      let produced: number;
      try {
        produced = inflateRawSync(bytes.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, uncompressed) }).length;
      } catch (error) {
        if (error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return tooBig("size");
        return notZip;
      }
      if (produced !== uncompressed) return notZip;
    } else if (method === METHOD_STORED) {
      if (deferred || compressed !== uncompressed || dataStart + compressed > bytes.length) return notZip;
    } else {
      return notZip;
    }
  }
  return { ok: true };
}
