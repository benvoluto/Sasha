import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { CFB_MESSAGE, checkXlsxZip, MAX_ZIP_ENTRIES } from "./zip-guard";

type Entry = { compressed: number; uncompressed: number; name?: string };

/** A zip that is only a central directory and its end record: enough to forge sizes. */
function forgedZip(entries: Entry[], opts: { count?: number } = {}): Uint8Array {
  const records = entries.map((e) => {
    const name = Buffer.from(e.name ?? "xl/worksheets/sheet1.xml");
    const r = Buffer.alloc(46 + name.length);
    r.writeUInt32LE(0x02014b50, 0);
    r.writeUInt32LE(e.compressed, 20);
    r.writeUInt32LE(e.uncompressed, 24);
    r.writeUInt16LE(name.length, 28);
    name.copy(r, 46);
    return r;
  });
  const cd = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.count ?? entries.length, 8);
  eocd.writeUInt16LE(opts.count ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16);
  return new Uint8Array(Buffer.concat([cd, eocd]));
}

type RealEntry = {
  data: Buffer;
  name?: string;
  /** Overrides for the sizes written in the directory and in the local header. */
  cd?: { compressed?: number; uncompressed?: number };
  local?: { compressed?: number; uncompressed?: number; flags?: number };
};

/** A complete zip with local headers and deflated data, sizes optionally forged. */
function realZip(entries: RealEntry[], opts: { tail?: Buffer } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name ?? "xl/worksheets/sheet1.xml");
    const packed = deflateRawSync(e.data);
    const lh = Buffer.alloc(30 + name.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.local?.flags ?? 0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(e.local?.compressed ?? packed.length, 18);
    lh.writeUInt32LE(e.local?.uncompressed ?? e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    name.copy(lh, 30);
    const r = Buffer.alloc(46 + name.length);
    r.writeUInt32LE(0x02014b50, 0);
    r.writeUInt16LE(8, 10);
    r.writeUInt32LE(e.cd?.compressed ?? packed.length, 20);
    r.writeUInt32LE(e.cd?.uncompressed ?? e.data.length, 24);
    r.writeUInt16LE(name.length, 28);
    r.writeUInt32LE(offset, 42);
    name.copy(r, 46);
    locals.push(lh, packed);
    records.push(r);
    offset += lh.length + packed.length;
  }
  const cd = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  if (opts.tail) eocd.writeUInt16LE(opts.tail.length, 20);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd, opts.tail ?? Buffer.alloc(0)]));
}

describe("checkXlsxZip", () => {
  it("passes a real workbook", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
    expect(checkXlsxZip(new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })))).toEqual({ ok: true });
    expect(checkXlsxZip(new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true })))).toEqual({ ok: true });
  });

  it("passes a small honest zip", () => {
    expect(checkXlsxZip(realZip([{ data: Buffer.from("<x>".repeat(1000)) }]))).toEqual({ ok: true });
  });

  it("refuses a directory with no local header behind it", () => {
    expect(checkXlsxZip(forgedZip([{ compressed: 500, uncompressed: 4000 }]))).toMatchObject({ ok: false, reason: "not_zip" });
  });

  it("refuses local sizes that differ from the directory (SheetJS inflates by the local header)", () => {
    const data = Buffer.alloc(5 * 1024 * 1024, 0x41);
    // An honest-looking directory over a local header that says "size unknown".
    expect(checkXlsxZip(realZip([{ data, cd: { uncompressed: 1000 }, local: { uncompressed: 0 } }]))).toMatchObject({ ok: false });
    expect(checkXlsxZip(realZip([{ data, cd: { uncompressed: 1000 }, local: { uncompressed: 1000 } }]))).toMatchObject({ ok: false });
    expect(checkXlsxZip(realZip([{ data: Buffer.from("abc"), local: { uncompressed: 0xfffffff0 } }]))).toMatchObject({ ok: false, reason: "not_zip" });
  });

  it("refuses a deflate stream that runs past its declared sizes", () => {
    // Both headers agree on small sizes; the stream itself inflates to far more.
    const data = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const packedLength = deflateRawSync(data).length;
    expect(
      checkXlsxZip(realZip([{ data, cd: { uncompressed: 1000 }, local: { uncompressed: 1000 } }])),
    ).toMatchObject({ ok: false, reason: "size" });
    // A compressed size shorter than the stream: SheetJS would read past it.
    expect(
      checkXlsxZip(realZip([{ data, cd: { compressed: Math.floor(packedLength / 2) }, local: { compressed: Math.floor(packedLength / 2) } }])),
    ).toMatchObject({ ok: false });
  });

  it("accepts a data-descriptor entry only when its stream matches the directory", () => {
    const data = Buffer.from("<row/>".repeat(500));
    expect(checkXlsxZip(realZip([{ data, local: { compressed: 0, uncompressed: 0, flags: 0x08 } }]))).toEqual({ ok: true });
    expect(
      checkXlsxZip(realZip([{ data: Buffer.alloc(3 * 1024 * 1024, 0x41), cd: { uncompressed: 4000 }, local: { compressed: 0, uncompressed: 0, flags: 0x08 } }])),
    ).toMatchObject({ ok: false });
  });

  it("uses the end record SheetJS uses and refuses a second one in the tail", () => {
    // A decoy end record whose comment hides a second signature near the end.
    const tail = Buffer.alloc(40);
    tail.writeUInt32LE(0x06054b50, 10);
    expect(checkXlsxZip(realZip([{ data: Buffer.from("<x/>") }], { tail }))).toMatchObject({ ok: false, reason: "not_zip" });
  });

  it("refuses an entry claiming a huge uncompressed size", () => {
    expect(checkXlsxZip(forgedZip([{ compressed: 10_000_000, uncompressed: 250 * 1024 * 1024 }]))).toMatchObject({ ok: false, reason: "size" });
  });

  it("refuses a total over the limit spread across entries", () => {
    const parts = Array.from({ length: 5 }, (_, i) => ({ compressed: 10_000_000, uncompressed: 50 * 1024 * 1024, name: `p${i}.xml` }));
    expect(checkXlsxZip(forgedZip(parts))).toMatchObject({ ok: false, reason: "size" });
  });

  it("refuses a compression ratio above 200:1 on a large entry", () => {
    expect(checkXlsxZip(forgedZip([{ compressed: 10_000, uncompressed: 5 * 1024 * 1024 }]))).toMatchObject({ ok: false, reason: "ratio" });
    // Small entries compress well legitimately.
    expect(checkXlsxZip(realZip([{ data: Buffer.alloc(100_000) }]))).toEqual({ ok: true });
  });

  it("refuses too many entries and ZIP64 markers", () => {
    expect(checkXlsxZip(forgedZip([{ compressed: 1, uncompressed: 1 }], { count: MAX_ZIP_ENTRIES + 1 }))).toMatchObject({ ok: false, reason: "entries" });
    expect(checkXlsxZip(forgedZip([{ compressed: 1, uncompressed: 1 }], { count: 0xffff }))).toMatchObject({ ok: false, reason: "zip64" });
    expect(checkXlsxZip(forgedZip([{ compressed: 0xffffffff, uncompressed: 0xffffffff }]))).toMatchObject({ ok: false, reason: "zip64" });
  });

  it("refuses the CFB signature of an encrypted or legacy file", () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(512).fill(0)]);
    expect(checkXlsxZip(cfb)).toEqual({ ok: false, reason: "cfb", message: CFB_MESSAGE });
  });

  it("refuses something that isn't a zip, or a directory that points outside it", () => {
    expect(checkXlsxZip(new TextEncoder().encode("Name,Amount\nAnn,1\n"))).toMatchObject({ ok: false, reason: "not_zip" });
    expect(checkXlsxZip(new Uint8Array(0))).toMatchObject({ ok: false, reason: "not_zip" });
    const broken = forgedZip([{ compressed: 1, uncompressed: 1 }], { count: 3 });
    expect(checkXlsxZip(broken)).toMatchObject({ ok: false, reason: "not_zip" });
  });
});
