// Live check of the Gemini table pass against the real model. Runs only with
// SASHA_LIVE_TESTS=1 and GEMINI_API_KEY set:
//   SASHA_LIVE_TESTS=1 npx vitest run src/lib/data/gemini-tables.live.test.ts
// Logs latency and counts only (never keys or other env values).
// With SASHA_RECORD_FIXTURES=1 as well, the model's validated replies are
// written to __fixtures__/gemini-tables.recorded.json, which
// gemini-tables.recorded.test.ts replays offline.

import { writeFileSync } from "node:fs";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env: rely on the environment.
}
// Nothing here touches a database, but keep the run in process memory regardless.
delete process.env.POSTGRES_URL;

import { GEMINI_MODEL } from "@/lib/gemini-model";
import { buildTable } from "./build";
import { readGeminiTables } from "./gemini-tables";

const live = process.env.SASHA_LIVE_TESTS === "1" && !!process.env.GEMINI_API_KEY;

const ROWS = [
  ["Region", "Q1 revenue", "Q2 revenue", "Growth"],
  ["North", "$12,400", "$13,950", "12.5%"],
  ["South", "$9,800", "$9,310", "(5.0%)"],
  ["East", "$15,200", "$16,720", "10.0%"],
  ["West", "$7,650", "$8,415", "10.0%"],
];

/** Page 1 prose; page 2 a ruled table of text lines with a caption. */
async function twoPagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const prose = doc.addPage([612, 792]);
  const lines = [
    "Regional sales review",
    "",
    "This note summarizes how each region performed in the first half of the year.",
    "Growth was strongest in the north and east, while the south declined slightly",
    "after a distributor changed hands. The figures are on the next page.",
  ];
  lines.forEach((l, i) => prose.drawText(l, { x: 72, y: 700 - i * 20, size: i === 0 ? 18 : 12, font: i === 0 ? bold : font }));

  const page = doc.addPage([612, 792]);
  page.drawText("Table 1. Revenue by region, first half", { x: 72, y: 700, size: 13, font: bold });
  const xs = [72, 192, 312, 432];
  ROWS.forEach((row, r) => {
    const y = 660 - r * 26;
    row.forEach((cell, c) => page.drawText(cell, { x: xs[c], y, size: 11, font: r === 0 ? bold : font }));
    page.drawLine({ start: { x: 66, y: y - 8 }, end: { x: 530, y: y - 8 }, thickness: r === 0 ? 1.2 : 0.4, color: rgb(0.3, 0.3, 0.3) });
  });
  return Buffer.from(await doc.save());
}

describe.skipIf(!live)("Gemini tables (live)", () => {
  it("finds the table on page 2 and reads its columns", { timeout: 240_000 }, async () => {
    const replies: Array<{ call: "check" | "extract"; chunk: { first: number; last: number | null }; data: unknown }> = [];
    const t0 = Date.now();
    const out = await readGeminiTables(await twoPagePdf(), { name: "regional-sales.pdf", mime: "application/pdf" }, { onReply: (call, data, chunk) => replies.push({ call, chunk, data }) });
    const ms = Date.now() - t0;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const tables = out.grids.map((g, i) => buildTable(g, { index: i })).filter((t) => t !== null);
    console.log(`[gemini-tables.live] ${ms} ms; ${replies.length} replies; ${tables.length} tables; columns ${tables.map((t) => t.columns.length).join(",")}`);
    expect(replies.find((r) => r.call === "check")?.data).toMatchObject({ pages: [2] });
    expect(tables.length).toBeGreaterThanOrEqual(1);
    expect(tables[0].page).toBe(2);
    expect(tables[0].columns.length).toBeGreaterThanOrEqual(2);
    expect(tables[0].rows.length).toBe(ROWS.length - 1);

    if (process.env.SASHA_RECORD_FIXTURES === "1") {
      const recorded = { recorded_at: new Date().toISOString(), model: GEMINI_MODEL, file: "regional-sales.pdf (2 pages, generated)", replies };
      writeFileSync(new URL("./__fixtures__/gemini-tables.recorded.json", import.meta.url), JSON.stringify(recorded, null, 2) + "\n");
    }
  });
});
