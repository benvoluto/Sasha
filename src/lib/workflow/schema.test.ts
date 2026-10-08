import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_SCHEMA } from "@/catalog/store";
import { DATA_SCHEMA } from "@/lib/data/schema";
import { DOCUMENT_SCHEMA } from "@/lib/documents/store";
import { SOURCE_SCHEMA } from "@/lib/sources/store";
import { SUGGESTION_SCHEMA } from "@/lib/suggestions/schema";
import { WORKFLOW_SCHEMA } from "./schema";

const root = join(__dirname, "..", "..", "..");
const setupRoute = readFileSync(join(root, "src/app/api/ontology/setup/route.ts"), "utf8");
const schemaSql = readFileSync(join(root, "db/schema.sql"), "utf8");
const squash = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").replace(/\s*([(),;])\s*/g, "$1").trim();

/** The setup route's EXPECTED_TABLES, read from its source (a route file can't export it). */
function expectedTables(): string[] {
  const block = setupRoute.match(/const EXPECTED_TABLES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("EXPECTED_TABLES not found");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("WORKFLOW_SCHEMA", () => {
  it("is idempotent-shaped: IF NOT EXISTS creates and adds, guarded renames and drops", () => {
    for (const stmt of WORKFLOW_SCHEMA) {
      const s = stmt.replace(/\s+/g, " ").trim();
      if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(s)) expect(s).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/);
      else if (/^ALTER TABLE/.test(s)) expect(s).toMatch(/ADD COLUMN IF NOT EXISTS/);
      else if (/^DROP/.test(s)) expect(s).toMatch(/^DROP (INDEX|TABLE) IF EXISTS/);
      else if (/^DO \$\$/.test(s)) expect(s).toMatch(/IF .* THEN/);
      else expect(s).toMatch(/^UPDATE .* WHERE .* IS NULL$/);
    }
  });

  it("creates the renamed tables with team scoping", () => {
    const all = WORKFLOW_SCHEMA.join("\n");
    for (const t of ["workflow", "workflow_version", "workflow_run", "app_setting"]) expect(all).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(\\s*[\\s\\S]*?team_id TEXT NOT NULL DEFAULT ''`));
    expect(all).toContain("PRIMARY KEY (team_id, key)");
    expect(all).toContain("CREATE INDEX IF NOT EXISTS workflow_run_doc_idx ON workflow_run (team_id, document_id, created_at DESC)");
    expect(all).not.toMatch(/INSERT INTO workflow /);
  });

  it("is mirrored statement for statement in db/schema.sql", () => {
    const sqlFile = squash(schemaSql);
    for (const stmt of WORKFLOW_SCHEMA) {
      // db/schema.sql writes the column checks out in full.
      const expanded = stmt.replace(/\$\{[^}]+\}/g, "");
      expect(sqlFile.includes(squash(expanded)) || stmt.startsWith("DO $$")).toBe(true);
    }
    for (const t of ["workflow", "workflow_version", "workflow_run", "app_setting"]) expect(schemaSql).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
  });

  it("is spread into the setup route, which no longer creates the retired report tables", () => {
    expect(setupRoute).toContain("...WORKFLOW_SCHEMA");
    expect(setupRoute).not.toMatch(/CREATE TABLE IF NOT EXISTS report/);
    expect(schemaSql).not.toMatch(/CREATE TABLE IF NOT EXISTS report/);
    expect(expectedTables()).not.toContain("report");
  });

  it("creates every table the setup route expects", () => {
    const statements = [setupRoute, ...WORKFLOW_SCHEMA, ...DOCUMENT_SCHEMA, ...SOURCE_SCHEMA, ...DATA_SCHEMA, ...CATALOG_SCHEMA, ...SUGGESTION_SCHEMA].join("\n");
    for (const t of expectedTables()) expect(statements, t).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
  });
});
