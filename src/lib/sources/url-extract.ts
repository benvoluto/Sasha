// Reading a web page someone pasted as a source. The server fetches the URL, so
// the URL is untrusted input aimed at our network: only http(s) to public
// addresses is allowed, every redirect is re-checked, and the connection itself
// resolves the host through the same check (so a DNS answer can't change
// between the check and the request). Responses are capped in time and size.
//
// HTML goes through Mozilla Readability (on linkedom, a light DOM) to keep the
// article and drop navigation and scripts; plain text is kept as is; a PDF is
// handed to the caller (ingest stores it and reads it with Gemini).

import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export const URL_FETCH_TIMEOUT_MS = 15_000;
export const URL_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** A failure worth showing the person as is. */
export class UrlSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlSourceError";
  }
}

export type LookupAll = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupAll = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved, incl. broadcast
  );
}

/** Expand an IPv6 address to eight 16-bit groups (handles "::" and a dotted IPv4 tail). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = ipv4Parts(v4[1]);
    if (!p) return null;
    s = s.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for any address the server must not fetch: loopback, private, link-local, CGNAT, ULA, metadata, multicast. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0]);
  if (kind === 4) return privateIpv4(ipv4Parts(ip)!);
  if (kind !== 6) return true; // not an IP at all: refuse
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 part.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return privateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  // Well-known NAT64 (64:ff9b::/96): judge the IPv4 part. Any other layout under
  // 64:ff9b::/32, including local-use 64:ff9b:1::/48, puts the IPv4 bits
  // somewhere we don't decode, so refuse it.
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g.slice(2, 6).some((x) => x !== 0)) return true;
    return privateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  // Transition ranges that tunnel to an embedded IPv4 address a relay would reach for us.
  if (g[0] === 0x2002) return true; // 6to4 (2002::/16)
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo (2001::/32)
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard (100::/64)
  if (g[0] === 0x2001 && (g[1] & 0xffe0) === 0x0020) return true; // ORCHIDv2 (2001:20::/28)
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true; // ORCHID (2001:10::/28, deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/**
 * Parse and check a URL: http or https, no credentials, a host that resolves
 * only to public addresses. Throws UrlSourceError with a readable reason.
 */
export async function assertPublicHttpUrl(raw: string, lookup: LookupAll = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UrlSourceError("That doesn't look like a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlSourceError("Only http and https links can be added.");
  if (url.username || url.password) throw new UrlSourceError("Links with a username or password can't be added.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UrlSourceError("Links to private or local addresses can't be added.");
  }
  let addresses: Array<{ address: string }>;
  if (isIP(host)) addresses = [{ address: host }];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new UrlSourceError(`Couldn't find ${host}. Check the address.`);
    }
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UrlSourceError("Links to private or local addresses can't be added.");
  }
  return url;
}

// --- Fetching --------------------------------------------------------------------

export type FetchedResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array>;
};
export type Fetcher = (url: URL, signal: AbortSignal) => Promise<FetchedResponse>;

type DnsLookupAll = (hostname: string, options: dns.LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void;

/**
 * Node's resolver, refusing to connect to anything assertPublicHttpUrl would
 * refuse. Exported (with the resolver injectable) for tests.
 */
export const guardedLookupWith = (resolve: DnsLookupAll = dns.lookup as unknown as DnsLookupAll): LookupFunction => (hostname, options, callback) => {
  resolve(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.length === 0 || list.some((a) => isPrivateAddress(a.address));
    if (bad) return callback(new UrlSourceError("Links to private or local addresses can't be added."), "", 0);
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const guardedLookup = guardedLookupWith();

/** A plain GET over node:http(s) with the guarded resolver; redirects are not followed. */
const nodeFetcher: Fetcher = (url, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SashaSourceReader/1.0)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (name) => {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(", ") : (v ?? null);
          } },
          body: res,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new UrlSourceError(`That page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function decode(bytes: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export type UrlSource = {
  title: string | null;
  text: string;
  /** Where the content was finally read from, after redirects. */
  finalUrl: string;
  contentType: string;
};

export type FetchUrlOptions = {
  fetcher?: Fetcher;
  lookup?: LookupAll;
  timeoutMs?: number;
  maxBytes?: number;
  /** Turns a PDF's bytes into text (stores it and reads it with Gemini). Without it a PDF link is refused. */
  onPdf?: (bytes: Buffer, finalUrl: URL) => Promise<string>;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Fetch a URL and return its readable text. Throws UrlSourceError (or a timeout) with a readable message. */
export async function fetchUrlSource(raw: string, opts: FetchUrlOptions = {}): Promise<UrlSource> {
  const fetcher = opts.fetcher ?? nodeFetcher;
  const maxBytes = opts.maxBytes ?? URL_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? URL_FETCH_TIMEOUT_MS);
  try {
    let url = await assertPublicHttpUrl(raw, opts.lookup);
    for (let hop = 0; ; hop++) {
      let res: FetchedResponse;
      try {
        res = await fetcher(url, controller.signal);
      } catch (error) {
        if (error instanceof UrlSourceError) throw error;
        if (controller.signal.aborted) throw new UrlSourceError("The page took too long to respond.");
        throw new UrlSourceError(`Couldn't reach ${url.hostname}.`);
      }
      if (REDIRECTS.has(res.status)) {
        const location = res.headers.get("location");
        if (!location) throw new UrlSourceError("The page redirected without saying where.");
        if (hop >= MAX_REDIRECTS) throw new UrlSourceError("The page redirected too many times.");
        url = await assertPublicHttpUrl(new URL(location, url).toString(), opts.lookup);
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw new UrlSourceError(`The page returned an error (${res.status}).`);
      const declared = Number(res.headers.get("content-length") ?? "");
      if (declared > maxBytes) throw new UrlSourceError(`That page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const bytes = await readCapped(res.body, maxBytes).catch((error) => {
        if (error instanceof UrlSourceError) throw error;
        if (controller.signal.aborted) throw new UrlSourceError("The page took too long to respond.");
        throw new UrlSourceError("The page stopped sending data before it finished.");
      });
      return await readBody(bytes, contentType, url, opts);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(bytes: Buffer, contentType: string, url: URL, opts: FetchUrlOptions): Promise<UrlSource> {
  const base = { finalUrl: url.toString(), contentType: contentType.split(";")[0].trim() };
  const isPdf = contentType.includes("application/pdf") || (!contentType && bytes.subarray(0, 5).toString("latin1") === "%PDF-");
  if (isPdf) {
    if (!opts.onPdf) throw new UrlSourceError("PDF links can't be read here.");
    const text = await opts.onPdf(bytes, url);
    return { ...base, title: pdfTitle(url), text };
  }
  if (contentType.includes("text/html") || contentType.includes("application/xhtml") || (!contentType && /^\s*</.test(bytes.subarray(0, 512).toString("latin1")))) {
    const page = extractReadable(decode(bytes, contentType), url.toString());
    return { ...base, ...page };
  }
  if (/^text\/(plain|markdown|csv|x-markdown)/.test(contentType)) {
    return { ...base, title: null, text: decode(bytes, contentType).trim() };
  }
  throw new UrlSourceError(`This link points to a ${base.contentType || "file of an unknown type"}, which can't be read yet.`);
}

function pdfTitle(url: URL): string | null {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  return last || null;
}

// --- HTML ------------------------------------------------------------------------

const BLOCK_CLOSE = /<\/(p|div|section|article|header|footer|aside|blockquote|pre|li|ul|ol|dl|dt|dd|tr|table|figure|figcaption|h[1-6])>/gi;

/** Plain text with paragraph breaks from an HTML fragment. */
function htmlToText(html: string): string {
  const marked = html.replace(BLOCK_CLOSE, "$&\n\n").replace(/<br\s*\/?>/gi, "\n");
  const { document } = parseHTML(`<!doctype html><html><body>${marked}</body></html>`);
  for (const el of document.querySelectorAll("script, style, noscript, template")) el.remove();
  const text = document.body?.textContent ?? "";
  return text
    .split("\n")
    .map((line: string) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The readable article of a page: its title and text, without navigation, scripts or boilerplate. */
export function extractReadable(html: string, url: string): { title: string | null; text: string } {
  const { document } = parseHTML(html);
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() || null;
  const fallbackTitle = meta('meta[property="og:title"]') ?? (document.querySelector("title")?.textContent?.trim() || null);
  let article: ReturnType<Readability["parse"]> = null;
  try {
    // Readability mutates the document it reads; give it its own copy.
    const { document: copy } = parseHTML(html);
    article = new Readability(copy as unknown as Document, { charThreshold: 200 }).parse();
  } catch (error) {
    console.warn(`[UrlExtract] Readability failed for ${url}:`, error);
  }
  const fromArticle = article?.content ? htmlToText(article.content) : "";
  if (fromArticle) return { title: article?.title?.trim() || fallbackTitle, text: fromArticle };
  // No article found: fall back to the main content area with the chrome removed.
  for (const el of document.querySelectorAll("script, style, noscript, template, nav, header, footer, aside, form, iframe, svg")) el.remove();
  const main = document.querySelector("article") ?? document.querySelector("main") ?? document.body;
  return { title: fallbackTitle, text: main ? htmlToText(main.innerHTML) : "" };
}
