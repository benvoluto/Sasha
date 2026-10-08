import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalType } from "../../src/catalog/test-fixtures";
import { buildCatalog, buildWorkflowData, catalogPaths, readTypeFiles, runCatalogBuild, type TypeFile } from "./catalog-build";

const file = (name: string, def: unknown): TypeFile => ({ file: `types/${name}.json`, name, raw: typeof def === "string" ? def : JSON.stringify(def) });

function tempRepo(types: Record<string, unknown>, data: { requirements?: Record<string, unknown>; workflows?: Record<string, unknown>; policies?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), "catalog-build-"));
  const paths = catalogPaths(root);
  mkdirSync(join(paths.typesDir, "_drafts"), { recursive: true });
  for (const [name, def] of Object.entries(types)) writeFileSync(join(paths.typesDir, name), typeof def === "string" ? def : JSON.stringify(def));
  for (const [dir, files] of [[paths.requirementsDir, data.requirements], [paths.workflowsDir, data.workflows]] as const) {
    if (!files) continue;
    mkdirSync(dir, { recursive: true });
    for (const [name, def] of Object.entries(files)) writeFileSync(join(dir, name), typeof def === "string" ? def : JSON.stringify(def));
  }
  if (data.policies !== undefined) writeFileSync(paths.policiesPath, typeof data.policies === "string" ? data.policies : JSON.stringify(data.policies));
  return paths;
}

const reqSet = (over: Record<string, unknown> = {}) => ({
  key: "limits",
  version: 1,
  title: "Limits",
  authority: "An agency",
  jurisdiction: "Somewhere",
  appliesTo: ["good"],
  effective: "",
  checked: "2026-10-08",
  provenance: { source: "The doc", url: "https://example.org/", license: "Paraphrased summary" },
  items: [{ key: "pages", kind: "limit", title: "Pages", text: "At most 2 pages.", value: 2, unit: "pages" }],
  ...over,
});

const workflow = (over: Record<string, unknown> = {}) => ({
  key: "type-good",
  version: 1,
  title: "Good",
  summary: "Checks a good document.",
  kind: "type",
  appliesTo: ["good"],
  outcome: { label: "Result", values: [{ key: "ok", label: "OK" }] },
  checkpoint: null,
  provenance: { source: "docs/workflows-by-document-type.md", checked: "2026-10-08" },
  steps: [{ id: "out", node: "outcome.report", config: { rules: [], fallback: "ok" } }],
  ...over,
});

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

describe("buildWorkflowData", () => {
  const types = new Set(["good", "other"]);
  const wf = (name: string, def: unknown) => ({ file: `workflows/${name}.json`, name, raw: typeof def === "string" ? def : JSON.stringify(def) });
  const rq = (name: string, def: unknown) => ({ file: `requirements/${name}.json`, name, raw: JSON.stringify(def) });

  it("bundles valid requirement sets and workflows sorted by key, with defaults applied", () => {
    const r = buildWorkflowData(
      { requirements: [rq("limits", reqSet())], workflows: [wf("type-good", workflow({ requirementSets: ["limits"] })), wf("generic-a", workflow({ key: "generic-a", kind: "generic", appliesTo: [] }))], policies: { file: "p.json", raw: JSON.stringify({ good: { sensitive: true, webDomains: ["example.org"] } }) } },
      types,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.workflowsBundle).map((w: { key: string }) => w.key)).toEqual(["generic-a", "type-good"]);
    expect(JSON.parse(r.workflowsBundle)[1]).toMatchObject({ fallback: false, params: [], notes: [] });
    expect(JSON.parse(r.requirementsBundle)[0]).toMatchObject({ key: "limits", status: "current", verifyNote: expect.stringMatching(/^Verify before relying/) });
    expect(r.requirementsBundle.endsWith("}\n]\n")).toBe(true);
  });

  it("reports schema errors, a file name that is not the key, unknown types and sets, and a second fallback", () => {
    const r = buildWorkflowData(
      {
        requirements: [rq("limits", reqSet({ appliesTo: ["nope"] })), rq("misnamed", reqSet({ key: "elsewhere" })), rq("broken", { key: "broken" })],
        workflows: [
          wf("type-good", workflow({ requirementSets: ["missing-set"], fallback: true })),
          wf("type-two", workflow({ key: "type-two", appliesTo: ["nope"], fallback: true })),
          wf("bad-json", "{"),
          wf("no-outcome", workflow({ key: "no-outcome", steps: [{ id: "a", node: "doc.read" }] })),
        ],
        policies: { file: "p.json", raw: JSON.stringify({ nope: {}, good: { sensitive: true } }) },
      },
      types,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join("\n");
    expect(all).toMatch(/requirements\/limits\.json: appliesTo\.0: "nope" is not a catalog type/);
    expect(all).toMatch(/requirements\/misnamed\.json: key: the key "elsewhere" must equal the file name "misnamed"/);
    expect(all).toMatch(/^requirements\/broken\.json: /m);
    expect(all).toMatch(/workflows\/type-good\.json: requirementSets\.0: no requirement set "missing-set"/);
    expect(all).toMatch(/workflows\/type-two\.json: appliesTo\.0: "nope" is not a catalog type/);
    expect(all).toMatch(/workflows\/type-two\.json: fallback: only one workflow may be the fallback/);
    expect(all).toMatch(/workflows\/bad-json\.json: \(root\): invalid JSON/);
    expect(all).toMatch(/workflows\/no-outcome\.json: steps: exactly one outcome\.report step is required/);
    expect(all).toMatch(/p\.json: nope: "nope" is not a catalog type/);
    expect(all).toMatch(/p\.json: good\.webDomains: a sensitive type needs public web domains/);
  });

  it("refuses an invalid policies file", () => {
    const r = buildWorkflowData({ requirements: [], workflows: [], policies: { file: "p.json", raw: JSON.stringify({ good: { draftAll: { enabled: "no" } } }) } }, types);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^p\.json: good\.draftAll/);
  });
});

describe("runCatalogBuild with workflows and requirement sets", () => {
  it("writes both bundles, and --check fails when a workflow changes", () => {
    const paths = tempRepo({ "good.json": minimalType({ key: "good" }) }, { requirements: { "limits.json": reqSet() }, workflows: { "type-good.json": workflow({ requirementSets: ["limits"] }) }, policies: {} });
    expect(runCatalogBuild(paths, { check: true }).code).toBe(1);
    const out = runCatalogBuild(paths);
    expect(out).toMatchObject({ code: 0 });
    expect(out.lines[0]).toMatch(/1 type\(s\), 1 requirement set\(s\), 1 workflow\(s\)/);
    expect(JSON.parse(readFileSync(paths.workflowsBundlePath, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(paths.requirementsBundlePath, "utf8"))[0].key).toBe("limits");
    expect(runCatalogBuild(paths, { check: true }).code).toBe(0);

    writeFileSync(join(paths.workflowsDir, "type-good.json"), JSON.stringify(workflow({ version: 2 })));
    const stale = runCatalogBuild(paths, { check: true });
    expect(stale.code).toBe(1);
    expect(stale.lines).toContain("src/catalog/workflows.bundle.json: out of date");
  });

  it("writes nothing when a workflow is invalid, even if every type is", () => {
    const paths = tempRepo({ "good.json": minimalType({ key: "good" }) }, { workflows: { "type-good.json": workflow({ appliesTo: ["missing"] }) } });
    const out = runCatalogBuild(paths);
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toMatch(/src\/catalog\/workflows\/type-good\.json: appliesTo\.0: "missing" is not a catalog type/);
    expect(existsSync(paths.bundlePath)).toBe(false);
    expect(existsSync(paths.workflowsBundlePath)).toBe(false);
  });
});
