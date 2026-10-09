import { describe, expect, it } from "vitest";
import { USAGE_CSV_COLUMNS } from "./contract";
import { usageCsv, usageCsvFilename } from "./csv";
import { csvGroups, type UsageRow } from "./query";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  day: "2026-10-07",
  ts: "2026-10-07T10:00:00.000Z",
  user: "u1",
  label: "ann@x.org",
  task: "draft.section",
  model: "claude-opus-5-5",
  allowed: true,
  input_tokens: 1000,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  web_search_requests: 0,
  ...over,
});

describe("usageCsv", () => {
  it("writes the header and one line per group in column order", () => {
    const csv = usageCsv(csvGroups([row()]));
    const [header, line, end] = csv.split("\r\n");
    expect(header).toBe(USAGE_CSV_COLUMNS.join(","));
    expect(line).toBe("2026-10-07,u1,ann@x.org,draft.section,claude-opus-5-5,1,0,1000,100,0,0,0,0.006");
    expect(end).toBe("");
  });

  it("neutralises formula-looking labels and quotes separators", () => {
    const csv = usageCsv(csvGroups([row({ label: "=HYPERLINK(\"x\")", user: "+u,1" })]));
    const line = csv.split("\r\n")[1];
    expect(line.startsWith('2026-10-07,"\'+u,1","\'=HYPERLINK(""x"")"')).toBe(true);
  });

  it("leaves an unknown cost empty", () => {
    const line = usageCsv(csvGroups([row({ model: "gemini-3.6-flash" })])).split("\r\n")[1];
    expect(line.endsWith(",")).toBe(true);
  });

  it("names the download after the range", () => {
    expect(usageCsvFilename({ from: "2026-09-01", to: "2026-09-30" })).toBe("sasha-usage-2026-09-01-to-2026-09-30.csv");
  });
});
