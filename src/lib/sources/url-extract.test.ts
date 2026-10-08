import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { assertPublicHttpUrl, extractReadable, fetchUrlSource, guardedLookupWith, isPrivateAddress, UrlSourceError, type Fetcher, type LookupAll } from "./url-extract";

const PUBLIC = "93.184.216.34";

/** Resolves hosts from a table; unknown hosts fail like NXDOMAIN. */
function lookupFrom(table: Record<string, string[]>): LookupAll {
  return async (host) => {
    const ips = table[host];
    if (!ips) throw new Error("ENOTFOUND");
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

type Reply = { status?: number; headers?: Record<string, string>; body?: string | Buffer | Uint8Array[] };

/** A fetcher that answers from a table keyed by URL. */
function fetcherFrom(table: Record<string, Reply>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: URL) => {
    calls.push(url.toString());
    const r = table[url.toString()];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const chunks = Array.isArray(r.body) ? r.body : [Buffer.from(r.body ?? "")];
    return {
      status: r.status ?? 200,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      body: (async function* () {
        for (const c of chunks) yield c;
      })(),
    };
  }) as unknown as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

const lookup = lookupFrom({
  "example.org": [PUBLIC],
  "news.example.org": [PUBLIC],
  "evil.example": ["10.0.0.5"],
  "mixed.example": [PUBLIC, "127.0.0.1"],
  "metadata.example": ["169.254.169.254"],
  "v6local.example": ["fd00::1"],
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b:1::a9fe:a9fe", // local-use NAT64
    "64:ff9b:1:a9fe:a9:fe00:101:101", // local-use NAT64, /48 layout
    "2002:a9fe:a9fe::", // 6to4 of 169.254.169.254
    "2002:808:808::1", // 6to4, even of a public address
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "100::1", // discard
    "2001:10::1", // ORCHID
    "2001:20::1", // ORCHIDv2
    "ff02::1",
    "not-an-ip",
  ])("refuses %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([PUBLIC, "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:4860:4860::8888"])("allows %s", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe("guardedLookupWith (the resolver the real connection uses)", () => {
  type Resolve = Parameters<typeof guardedLookupWith>[0];
  const resolver = (addresses: LookupAddress[], err: Error | null = null): NonNullable<Resolve> & { options: unknown[] } => {
    const options: unknown[] = [];
    const f = ((_host: string, opts: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => {
      options.push(opts);
      cb(err, addresses);
    }) as NonNullable<Resolve> & { options: unknown[] };
    f.options = options;
    return f;
  };
  const run = (lookup: ReturnType<typeof guardedLookupWith>, all: boolean) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      lookup("host.example", { all } as never, ((err: Error | null, address: unknown, family?: number) => resolve({ err, address, family })) as never),
    );

  it("answers in the single-address form, always resolving every address", async () => {
    const r = resolver([{ address: PUBLIC, family: 4 }]);
    expect(await run(guardedLookupWith(r), false)).toEqual({ err: null, address: PUBLIC, family: 4 });
    expect(r.options[0]).toMatchObject({ all: true });
  });

  it("answers in the all-addresses form when asked (autoSelectFamily)", async () => {
    const list = [{ address: PUBLIC, family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    const out = await run(guardedLookupWith(resolver(list)), true);
    expect(out.err).toBeNull();
    expect(out.address).toEqual(list);
  });

  it.each([true, false])("refuses when any address is private (all: %s)", async (all) => {
    const out = await run(guardedLookupWith(resolver([{ address: PUBLIC, family: 4 }, { address: "169.254.169.254", family: 4 }])), all);
    expect(out.err).toBeInstanceOf(UrlSourceError);
  });

  it("refuses an empty answer and passes resolver errors through", async () => {
    expect((await run(guardedLookupWith(resolver([])), false)).err).toBeInstanceOf(UrlSourceError);
    const nx = new Error("ENOTFOUND");
    expect((await run(guardedLookupWith(resolver([], nx)), true)).err).toBe(nx);
  });
});

describe("assertPublicHttpUrl", () => {
  it("accepts a public http(s) URL", async () => {
    expect((await assertPublicHttpUrl("https://example.org/a?b=1", lookup)).toString()).toBe("https://example.org/a?b=1");
  });

  it.each([
    ["file:///etc/passwd", /Only http and https/],
    ["ftp://example.org/x", /Only http and https/],
    ["javascript:alert(1)", /Only http and https/],
    ["not a url", /doesn't look like/],
    ["https://user:pw@example.org/", /username or password/],
    ["http://localhost:3000/", /private or local/],
    ["http://app.localhost/", /private or local/],
    ["http://127.0.0.1/", /private or local/],
    ["http://[::1]/", /private or local/],
    ["http://169.254.169.254/latest/meta-data/", /private or local/],
    ["http://evil.example/", /private or local/],
    ["http://mixed.example/", /private or local/],
    ["http://metadata.example/", /private or local/],
    ["http://v6local.example/", /private or local/],
    ["http://nowhere.example/", /Couldn't find/],
  ])("refuses %s", async (url, message) => {
    await expect(assertPublicHttpUrl(url, lookup)).rejects.toThrow(message);
  });
});

const ARTICLE_HTML = `<!doctype html><html><head><title>Site | River plan</title>
<meta property="og:title" content="The river plan">
<script>window.tracker = "BAD-SCRIPT";</script><style>.x{color:red}</style></head>
<body>
<nav><a href="/">Home</a> <a href="/about">NAV-LINK</a></nav>
<header>SITE-HEADER</header>
<article>
<h1>The river plan</h1>
<p>The city council approved a new plan for the riverside on Tuesday, committing forty thousand dollars to restoration of the wetlands along the eastern bank.</p>
<p>Work will begin in the spring and is expected to take two years, according to the parks department, which will publish quarterly progress reports for residents.</p>
<p>Residents can comment on the plan until the end of the month at the public library or online through the city's website, the council said in its statement.</p>
</article>
<footer>FOOTER-TEXT</footer>
<script>console.log("BAD-SCRIPT-2")</script>
</body></html>`;

describe("extractReadable", () => {
  it("keeps the article and title and drops scripts, styles and navigation", () => {
    const page = extractReadable(ARTICLE_HTML, "https://example.org/river");
    expect(page.title).toMatch(/river plan/i);
    expect(page.text).toContain("approved a new plan for the riverside");
    expect(page.text).toContain("quarterly progress reports");
    expect(page.text).not.toContain("BAD-SCRIPT");
    expect(page.text).not.toContain("NAV-LINK");
    expect(page.text).not.toContain("FOOTER-TEXT");
    expect(page.text).not.toContain("color:red");
    // Paragraphs stay separate.
    expect(page.text).toMatch(/bank\.\n+Work will begin/);
  });

  // A live read of a Wikipedia article kept every "[edit]" link, footnote marker and the whole reference list.
  it("drops wiki edit links, footnote markers and reference lists", () => {
    const para = "The Border Collie is a British breed of herding dog of medium size, descended from landrace sheepdogs once found all over the British Isles.";
    const html = `<html><head><title>Border Collie</title></head><body><article>
<h2>History<span class="mw-editsection">[<a href="/edit">edit</a>]</span></h2>
<p>${para}<sup class="reference"><a href="#cite-1">[1]</a></sup> ${para}</p>
<p>${para} It is used for working livestock and in dog sports.<sup class="reference">[2]</sup></p>
<div class="mw-references-wrap"><ol class="references"><li><span class="mw-cite-backlink">↑</span> REFERENCE-ONE. Retrieved 6 June 2026.</li></ol></div>
<div class="navbox">NAVBOX-LINKS</div>
</article></body></html>`;
    const page = extractReadable(html, "https://en.wikipedia.org/wiki/Border_Collie");
    expect(page.text).toContain("British breed of herding dog");
    expect(page.text).toContain("History");
    expect(page.text).not.toContain("[edit]");
    expect(page.text).not.toMatch(/\[\d\]/);
    expect(page.text).not.toContain("REFERENCE-ONE");
    expect(page.text).not.toContain("NAVBOX-LINKS");
  });

  it("falls back to the main content for a page Readability can't use", () => {
    const html = `<html><head><title>Tiny</title></head><body><nav>MENU</nav><main><p>Short note.</p></main><script>BAD()</script></body></html>`;
    const page = extractReadable(html, "https://example.org/");
    expect(page.title).toBe("Tiny");
    expect(page.text).toContain("Short note.");
    expect(page.text).not.toContain("BAD()");
  });
});

describe("fetchUrlSource", () => {
  it("reads an HTML page", async () => {
    const fetcher = fetcherFrom({ "https://example.org/river": { headers: { "content-type": "text/html; charset=utf-8" }, body: ARTICLE_HTML } });
    const out = await fetchUrlSource("https://example.org/river", { fetcher, lookup });
    expect(out.contentType).toBe("text/html");
    expect(out.text).toContain("riverside");
    expect(out.finalUrl).toBe("https://example.org/river");
  });

  it("keeps plain text as is", async () => {
    const fetcher = fetcherFrom({ "https://example.org/a.txt": { headers: { "content-type": "text/plain" }, body: "  line one\nline two  " } });
    expect(await fetchUrlSource("https://example.org/a.txt", { fetcher, lookup })).toMatchObject({ title: null, text: "line one\nline two" });
  });

  it("follows public redirects and reports the final URL", async () => {
    const fetcher = fetcherFrom({
      "https://example.org/old": { status: 301, headers: { location: "/new" } },
      "https://example.org/new": { status: 302, headers: { location: "https://news.example.org/story" } },
      "https://news.example.org/story": { headers: { "content-type": "text/plain" }, body: "story" },
    });
    const out = await fetchUrlSource("https://example.org/old", { fetcher, lookup });
    expect(out).toMatchObject({ text: "story", finalUrl: "https://news.example.org/story" });
    expect(fetcher.calls).toHaveLength(3);
  });

  it("refuses a redirect to a private address without fetching it", async () => {
    const fetcher = fetcherFrom({
      "https://example.org/go": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
    });
    await expect(fetchUrlSource("https://example.org/go", { fetcher, lookup })).rejects.toThrow(/private or local/);
    expect(fetcher.calls).toEqual(["https://example.org/go"]);
  });

  it("refuses a redirect to a host that resolves privately", async () => {
    const fetcher = fetcherFrom({ "https://example.org/go": { status: 307, headers: { location: "http://evil.example/admin" } } });
    await expect(fetchUrlSource("https://example.org/go", { fetcher, lookup })).rejects.toThrow(/private or local/);
    expect(fetcher.calls).toHaveLength(1);
  });

  it("refuses a redirect to another scheme", async () => {
    const fetcher = fetcherFrom({ "https://example.org/go": { status: 302, headers: { location: "file:///etc/passwd" } } });
    await expect(fetchUrlSource("https://example.org/go", { fetcher, lookup })).rejects.toThrow(/Only http and https/);
  });

  it("stops after too many redirects", async () => {
    const table: Record<string, Reply> = {};
    for (let i = 0; i < 10; i++) table[`https://example.org/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    await expect(fetchUrlSource("https://example.org/0", { fetcher: fetcherFrom(table), lookup })).rejects.toThrow(/too many times/);
  });

  it("enforces the size cap on the declared length", async () => {
    const fetcher = fetcherFrom({ "https://example.org/big": { headers: { "content-type": "text/plain", "content-length": "999999" }, body: "x" } });
    await expect(fetchUrlSource("https://example.org/big", { fetcher, lookup, maxBytes: 1000 })).rejects.toThrow(/larger than/);
  });

  it("enforces the size cap while streaming when no length is declared", async () => {
    const chunk = new Uint8Array(400);
    const fetcher = fetcherFrom({ "https://example.org/stream": { headers: { "content-type": "text/plain" }, body: [chunk, chunk, chunk] } });
    await expect(fetchUrlSource("https://example.org/stream", { fetcher, lookup, maxBytes: 1000 })).rejects.toThrow(/larger than/);
  });

  it("times out a slow server", async () => {
    const fetcher: Fetcher = (_url, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(fetchUrlSource("https://example.org/slow", { fetcher, lookup, timeoutMs: 20 })).rejects.toThrow(/too long/);
  });

  it("reports HTTP errors", async () => {
    const fetcher = fetcherFrom({ "https://example.org/missing": { status: 404 } });
    await expect(fetchUrlSource("https://example.org/missing", { fetcher, lookup })).rejects.toThrow(/\(404\)/);
  });

  it("hands a PDF to onPdf, and refuses it without one", async () => {
    const pdf = Buffer.from("%PDF-1.7 fake");
    const fetcher = fetcherFrom({ "https://example.org/files/report.pdf": { headers: { "content-type": "application/pdf" }, body: pdf } });
    const onPdf = vi.fn(async (bytes: Buffer) => `read ${bytes.length} bytes`);
    const out = await fetchUrlSource("https://example.org/files/report.pdf", { fetcher, lookup, onPdf });
    expect(out).toMatchObject({ title: "report.pdf", text: `read ${pdf.length} bytes`, contentType: "application/pdf" });
    expect(onPdf).toHaveBeenCalledOnce();
    await expect(fetchUrlSource("https://example.org/files/report.pdf", { fetcher, lookup })).rejects.toThrow(/PDF links/);
  });

  it("refuses types it can't read", async () => {
    const fetcher = fetcherFrom({ "https://example.org/x.zip": { headers: { "content-type": "application/zip" }, body: "PK" } });
    await expect(fetchUrlSource("https://example.org/x.zip", { fetcher, lookup })).rejects.toThrow(/application\/zip/);
  });
});
