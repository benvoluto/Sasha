import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalType } from "../../src/catalog/test-fixtures";
import { buildCatalog, catalogPaths, readTypeFiles, runCatalogBuild, type TypeFile } from "./catalog-build";

const file = (name: string, def: unknown): TypeFile => ({ file: `types/${name}.json`, name, raw: typeof def === "string" ? def : JSON.stringify(def) });

function tempRepo(types: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "catalog-build-"));
  const paths = catalogPaths(root);
  mkdirSync(join(paths.typesDir, "_drafts"), { recursive: true });
  for (const [name, def] of Object.entries(types)) writeFileSync(join(paths.typesDir, name), typeof def === "string" ? def : JSON.stringify(def));
  return paths;
}

describe("buildCatalog", () => {
  it("bundles valid definitions sorted by key, sections by order, with defaults and an index", () => {
    const r = buildCatalog([file("zeta", minimalType({ key: "zeta", title: "Z" })), file("alpha", minimalType({ key: "alpha", title: "A", signals: ["x"] }))]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bundle = JSON.parse(r.bundle);
    expect(bundle.map((d: { key: string }) => d.key)).toEqual(["alpha", "zeta"]);
    expect(bundle[0].sections.map((s: { key: string }) => s.key)).toEqual(["ask", "context"]);
    expect(bundle[0].sections[0].renderer).toBe("narrative");
    expect(JSON.parse(r.index)[0]).toEqual({ key: "alpha", version: 1, title: "A", family: "business", summary: "A short brief.", signals: ["x"] });
    expect(r.bundle.endsWith("}\n]\n")).toBe(true);
  });

  it("reports invalid JSON, schema errors, a file name that is not the key, and alias clashes", () => {
    const r = buildCatalog([
      file("broken", "{ nope"),
      file("bad", { ...minimalType({ key: "bad" }), extra: true }),
      file("named-wrong", minimalType({ key: "other" })),
      file("one", minimalType({ key: "one", aliases: ["shared"] })),
      file("two", minimalType({ key: "two", aliases: ["shared", "one"] })),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join("\n");
    expect(all).toMatch(/^types\/broken\.json: \(root\): invalid JSON/m);
    expect(all).toMatch(/^types\/bad\.json: /m);
    expect(all).toMatch(/types\/named-wrong\.json: key: the key "other" must equal the file name "named-wrong"/);
    expect(all).toMatch(/types\/two\.json: aliases\.0: "shared" is also an alias in types\/one\.json/);
    expect(all).toMatch(/types\/two\.json: aliases\.1: "one" is the key of another type/);
  });
});

describe("runCatalogBuild", () => {
  it("writes nothing and exits 1 when any file is invalid", () => {
    const paths = tempRepo({ "good.json": minimalType({ key: "good" }), "bad.json": { key: "bad" } });
    const out = runCatalogBuild(paths);
    expect(out.code).toBe(1);
    expect(out.lines.some((l) => l.startsWith("src/catalog/types/bad.json: "))).toBe(true);
    expect(existsSync(paths.bundlePath)).toBe(false);
    expect(existsSync(paths.indexPath)).toBe(false);
  });

  it("ignores dotfiles and _drafts, writes the files, and --check passes until a type changes", () => {
    const paths = tempRepo({ "good.json": minimalType({ key: "good" }), ".hidden.json": "{", "_drafts/draft.json": "{" });
    expect(readTypeFiles(paths.typesDir, paths.root).map((f) => f.name)).toEqual(["good"]);
    expect(runCatalogBuild(paths, { check: true }).code).toBe(1);
    expect(runCatalogBuild(paths).code).toBe(0);
    expect(JSON.parse(readFileSync(paths.bundlePath, "utf8"))).toHaveLength(1);
    expect(runCatalogBuild(paths, { check: true })).toMatchObject({ code: 0 });

    writeFileSync(join(paths.typesDir, "good.json"), JSON.stringify(minimalType({ key: "good", version: 2 })));
    const stale = runCatalogBuild(paths, { check: true });
    expect(stale.code).toBe(1);
    expect(stale.lines.join("\n")).toMatch(/run npm run catalog:build/);
  });
});
