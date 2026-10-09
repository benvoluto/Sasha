// Images for export (phase7-spec.md §4.1): every image `src` in the document
// resolved once, before any writer runs. Only two kinds are embedded:
// - data: images (png, jpeg, gif, webp, svg), decoded and checked against
//   their magic bytes;
// - our own source file route (`/api/sources/<id>/file`, relative or on this
//   origin), read through the team-checked source store from our own Blob
//   store and inlined.
// Nothing else is ever fetched: an external URL, another route or a bad data
// URI resolves to null, and the writers print "[Image: alt]". Once the total
// passes MAX_EXPORT_IMAGE_BYTES, the remaining images resolve to null too.
//
// Server-only (the source store and the Blob token).

import { blobAuthHeaders, isOwnBlobUrl } from "@/lib/blob-host";
import type { PMNode } from "@/lib/documents/sections";
import { getSource } from "@/lib/sources/store";
import { MAX_EXPORT_IMAGE_BYTES, type ExportImage, type ExportImages } from "./contract";

type Mime = ExportImage["mime"];

// --- Pure helpers --------------------------------------------------------------------

/** The image type from the bytes themselves (never from a claimed type), or null. */
export function sniffImage(data: Uint8Array): Mime | null {
  const b = data;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && String.fromCharCode(...b.subarray(0, 4)) === "GIF8") return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/** Pixel size from a PNG, JPEG, GIF or WebP header, or null. */
export function imageSize(data: Uint8Array, mime: Mime): { width: number; height: number } | null {
  const b = data;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null);
  if (mime === "image/png" && b.length >= 24) return ok(be32(16), be32(20));
  if (mime === "image/gif" && b.length >= 10) return ok(le16(6), le16(8));
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) don't.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(be16(i + 7), be16(i + 5));
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      i += 2 + be16(i + 2);
    }
    return null;
  }
  if (mime === "image/webp" && b.length >= 30) {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === "VP8X") return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    if (chunk === "VP8 ") return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
  }
  return null;
}

const DATA_URI = /^data:(image\/(?:png|jpe?g|gif|webp|svg\+xml))((?:;[^,;]*)*),([\s\S]*)$/i;

/** A data: image decoded, or null when it is malformed or its bytes aren't the image type it claims. */
export function decodeDataImage(src: string): { mime: Mime; data: Uint8Array } | null {
  const m = DATA_URI.exec(src.trim());
  if (!m) return null;
  let data: Uint8Array;
  try {
    data = /;base64/i.test(m[2]) ? new Uint8Array(Buffer.from(m[3].replace(/\s+/g, ""), "base64")) : new TextEncoder().encode(decodeURIComponent(m[3]));
  } catch {
    return null;
  }
  const claimed = m[1].toLowerCase().replace("image/jpg", "image/jpeg") as Mime;
  return data.length && sniffImage(data) === claimed ? { mime: claimed, data } : null;
}

/** The source id when `src` is our own file route (relative, or absolute on `origin`), else null. */
export function ownSourceFileId(src: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const m = /^\/api\/sources\/([A-Za-z0-9_-]{1,100})\/file$/.exec(url.pathname);
  return m ? m[1] : null;
}

export const toExportImage = (mime: Mime, data: Uint8Array): ExportImage => {
  const size = imageSize(data, mime);
  return { mime, data, dataUri: `data:${mime};base64,${Buffer.from(data).toString("base64")}`, width: size?.width ?? null, height: size?.height ?? null };
};

/** Every image src in document order, once each. */
export function imageSources(doc: PMNode): string[] {
  const out = new Set<string>();
  const walk = (n: PMNode) => {
    if (n.type === "image" && typeof n.attrs?.src === "string" && n.attrs.src) out.add(n.attrs.src);
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return [...out];
}

// --- Resolution ------------------------------------------------------------------------

const UPLOAD_MIMES = new Set<Mime>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Reads one of the team's source files when it is an image on our own Blob store, within `budget` bytes. */
async function readSourceImage(teamId: string, sourceId: string, budget: number): Promise<{ mime: Mime; data: Uint8Array } | null> {
  const source = await getSource(teamId, sourceId);
  if (!source?.blob_url || !isOwnBlobUrl(source.blob_url) || !UPLOAD_MIMES.has((source.mime ?? "") as Mime)) return null;
  if (source.bytes && source.bytes > budget) return null;
  const res = await fetch(source.blob_url, { headers: blobAuthHeaders(source.blob_url), cache: "no-store", redirect: "error" });
  if (!res.ok) return null;
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > budget) return null;
  const data = new Uint8Array(await res.arrayBuffer());
  const mime = sniffImage(data);
  return data.length <= budget && mime && UPLOAD_MIMES.has(mime) ? { mime, data } : null;
}

/**
 * Resolves every image in `doc` for `teamId`. Never throws: a failed read is
 * an alt-text image, logged without its URL.
 */
export async function resolveImages(doc: PMNode, opts: { teamId: string; origin: string; maxBytes?: number }): Promise<ExportImages> {
  const out: ExportImages = new Map();
  let budget = opts.maxBytes ?? MAX_EXPORT_IMAGE_BYTES;
  for (const src of imageSources(doc)) {
    let found: { mime: Mime; data: Uint8Array } | null = null;
    if (/^\s*data:/i.test(src)) found = decodeDataImage(src);
    else {
      const sourceId = ownSourceFileId(src, opts.origin);
      if (sourceId && budget > 0) {
        try {
          found = await readSourceImage(opts.teamId, sourceId, budget);
        } catch (err) {
          console.warn("[export] source image read failed", { sourceId, error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }
    if (found && found.data.length <= budget) {
      budget -= found.data.length;
      out.set(src, toExportImage(found.mime, found.data));
    } else out.set(src, null);
  }
  return out;
}
